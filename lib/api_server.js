/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var fs = require("fs");
var http = require("http");
var https = require("https");
var util = require("util");

var async = require("async");
var express = require("express");
var log = require("floorine");
var request = require("request");
var _ = require("lodash");

var cache = require("./cache");
var colab = require("./colab");
var db = require("./db");
var settings = require("./settings");

request = request.defaults({
  sendImmediately: true,
  strictSSL: false
});

var AUTH_USER = settings.auth.username;
var AUTH_PASS = settings.auth.password;


var Server = function (controller) {
  var self = this,
    auth = express.basicAuth(AUTH_USER, AUTH_PASS);

  self.controller = controller;
  self.app = express();
  self.app.use(express.bodyParser());
  self.app.use(express.logger());

  /*jslint stupid: true */
  if (settings.https_port) {
    self.cert = fs.readFileSync(settings.ssl_cert);
    self.key = fs.readFileSync(settings.ssl_key);
    if (settings.ssl_ca) {
      self.ca = [];
      _.each(settings.ssl_ca, function (filename) {
        self.ca.push(fs.readFileSync(filename));
      });
    }
  }
  /*jslint stupid: false */

  if (settings.https_port) {
    log.log("HTTPS enabled on port", settings.https_port);
    self.server_ssl = https.createServer({
      ca: self.ca,
      cert: self.cert,
      key: self.key,
      ciphers: "ECDHE-RSA-AES256-SHA384:AES256-SHA256:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM",
      honorCipherOrder: true
    }, self.app);
  }

  self.server = http.createServer(self.app);

  self.app.get("/r/:owner/:workspace", self.handle_get_workspace_by_name.bind(self));
  self.app.get("/t/:token", self.handle_request.bind(self, "token"));
  self.app.get("/u/:username", self.handle_request.bind(self, "username"));
  self.app.get("/workspace/:workspace_id", self.handle_get_workspace.bind(self));

  /* Everything below this should require auth. */

  self.app.get("/stats", auth, self.handle_get_stats.bind(self));

  self.app["delete"]("/r/:owner/:workspace", auth, self.handle_delete_workspace_by_name.bind(self));
  self.app["delete"]("/workspace/:workspace_id", auth, self.handle_delete_workspace.bind(self));
  self.app.post("/workspace/:workspace_id/pin", auth, self.handle_pin_workspace.bind(self));
  self.app.post("/workspace/:workspace_id/evict", auth, self.handle_evict_workspace.bind(self));
  self.app.post("/motd", auth, self.handle_motd.bind(self));
  self.app.post("/wallops", auth, self.handle_wallops.bind(self));
};

Server.prototype.listen = function (cb) {
  var self = this,
    auto = {};

  auto.http_listen = function (cb) {
    log.log("Starting HTTP server on port", settings.http_port);
    self.server.listen(settings.http_port, function (err) {
      if (err) {
        log.error(err);
      } else {
        log.log("HTTP server listening on port", settings.http_port);
      }
      return cb(err);
    });
  };

  if (self.server_ssl) {
    auto.https_listen = function (cb) {
      log.log("Starting HTTPS server on port", settings.http_port);
      self.server_ssl.listen(settings.https_port, function (err) {
        if (err) {
          log.error(err);
        } else {
          log.log("HTTPS server listening on port", settings.https_port);
        }
        return cb(err);
      });
    };
  }

  async.auto(auto, cb);
};

Server.prototype.stop = function (cb) {
  var self = this,
    auto = {};

  auto.close_server = function (cb) {
    log.log("Closing HTTP server...");
    self.server.close(cb);
  };

  if (self.server_ssl) {
    auto.close_ssl = function (cb) {
      log.log("Closing HTTPS server...");
      self.server_ssl.close(cb);
    };
  }

  async.auto(auto, cb);
};

Server.prototype.handle_request = function (namespace, req, res) {
  var self = this,
    data = self.controller.find_server(namespace, req.params[namespace]);

  log.debug(data);
  res.json(200, data);
};

Server.prototype.handle_get_workspace = function (req, res) {
  var self = this,
    workspace_id = req.params.workspace_id,
    colab = self.controller.server_mapping.workspace[workspace_id],
    workspace = self.controller.workspaces[workspace_id];

  if (colab) {
    return res.json(200, {
      ip: colab.ip,
      port: colab.colab_port,
      ssl: colab.ssl
    });
  }

  if (!workspace) {
    // Lame special case. whatever.
    return self.controller.create_workspace(workspace_id, function (err, workspace) {
      if (err) {
        return res.send(500, err);
      }
      log.log("Created workspace %s", workspace_id);
      colab = _.keys(workspace.colabs)[0];
      colab = self.controller.colab_servers[colab];
      self.controller.server_mapping.workspace[workspace_id] = colab;
      return res.json(200, {
        ip: colab.ip,
        port: colab.colab_port,
        ssl: colab.ssl
      });
    });
  }

  colab = self.controller.get_source(workspace);
  if (!colab) {
    return res.json(404);
  }
  self.controller.server_mapping.workspace[workspace_id] = colab;
  return res.json(200, {
    ip: colab.ip,
    port: colab.colab_port,
    ssl: colab.ssl
  });
};

Server.prototype.handle_get_workspace_by_name = function (req, res) {
  var self = this,
    owner = req.params.owner,
    workspace = req.params.workspace;

  db.get_workspace(owner, workspace, function (err, result) {
    if (err) {
      log.error("Error finding workspace %s/%s: %s", owner, workspace, err);
      return res.send(500, err);
    }
    self.handle_get_workspace({ params: { workspace_id: result.id }}, res);
  });
};

Server.prototype.handle_evict_workspace = function (req, res) {
  var self = this,
    key = util.format("%s", req.params.workspace_id),
    server = self.controller.server_mapping.workspace[key];

  if (!server) {
    return res.json(404, {error: util.format("Server not found for workspace %s. Probably inactive.", key)});
  }

  return self.controller.evict_workspace(server, req.params.workspace_id, function (err) {
    if (err) {
      return res.send(500, err);
    }
    res.send(204);
  });
};

Server.prototype.handle_delete_workspace_by_name = function (req, res) {
  var self = this,
    owner = req.params.owner,
    workspace = req.params.workspace;

  db.get_workspace(owner, workspace, function (err, result) {
    if (err) {
      // TODO: check for not found and send a 404
      log.error("Error finding workspace %s/%s: %s", owner, workspace, err);
      return res.send(500, err);
    }
    return self.handle_delete_workspace({ params: { workspace_id: result.id }}, res);
  });
};

Server.prototype.handle_delete_workspace = function (req, res) {
  var self = this,
    colabs,
    workspace_id = req.params.workspace_id,
    workspace = self.controller.workspaces[workspace_id];

  if (!workspace || !workspace.colabs || _.size(workspace.colabs) === 0) {
    return res.json(404, {error: util.format("Server not found for workspace %s", workspace_id)});
  }

  /*jslint unparam: true */
  colabs = _.map(workspace.colabs, function (colab, colab_id) {
    return self.controller.colab_servers[colab_id];
  });
  /*jslint unparam: false */
  async.forEach(colabs, function (colab, cb) {
    workspace.action = {
      running: false,
      name: "delete"
    };
    self.controller.delete_workspace(workspace, colab, cb);
  }, function (err) {
    delete workspace.action;
    if (err) {
      return res.send(500, err);
    }
    delete self.controller.workspaces[workspace_id];
    return res.send(204);
  });
};

Server.prototype.handle_pin_workspace = function (req, res) {
  var self = this,
    key = util.format("%s", req.params.workspace_id),
    name = req.body.name,
    old_server,
    server;

  if (!name) {
    return res.json(400, {error: "Bad request. Need server name."});
  }

  server = _.where(self.controller.colab_servers, {"name": name})[0];

  if (!server) {
    return res.json(404, {error: util.format("No server named %s", name)});
  }

  log.log("Pinned workspace %s to server %s (%s:%s)", key, server.name, server.ip, server.colab_port);

  old_server = self.controller.server_mapping.workspace[key];
  self.controller.server_mapping.workspace[key] = server;

  if (!old_server) {
    return res.json(200, server.to_json());
  }

  return self.controller.evict_workspace(old_server, req.params.workspace_id, function (err, result) {
    if (err) {
      return res.send(err, result);
    }
    return res.json(200, server.to_json());
  });
};

Server.prototype.handle_wallops = function (req, res) {
  var self = this;

  log.warn("Wallops:", req.body.msg);
  if (!req.body.msg) {
    log.error("No message. Bad wallops request.");
    return res.send(400, "NEED A MESSAGE");
  }

  async.each(self.controller.colab_servers, function (colab_server, cb) {
    var options = {
        auth: {
          user: AUTH_USER,
          password: AUTH_PASS
        },
        json: req.body,
        rejectUnauthorized: false
      },
      url = util.format("%s://%s:%s/wallops", (colab_server.ssl ? "https" : "http"), colab_server.ip, colab_server.api_port);

    log.debug("Hitting", url);
    request.post(url, options, function (err, response, body) {
      if (err) {
        return cb(err);
      }
      if (response.statusCode >= 400) {
        return cb(util.format("Code %s from %s", response.statusCode, url));
      }
      return cb(null, body);
    });
  }, function (err) {
    if (err) {
      log.error("Error setting wallops:", err);
      res.send(500, err);
    }
    res.send(200, req.body.msg);
  });
};

Server.prototype.handle_motd = function (req, res) {
  var self = this;

  log.warn("MOTD:", req.body);
  async.each(self.controller.colab_servers, function (colab_server, cb) {
    var options = {
        auth: {
          user: AUTH_USER,
          password: AUTH_PASS
        },
        json: req.body,
        rejectUnauthorized: false
      },
      url = util.format("%s://%s:%s/motd", (colab_server.ssl ? "https" : "http"), colab_server.ip, colab_server.api_port);

    log.debug("Hitting", url);
    request.post(url, options, function (err, response, body) {
      if (err) {
        return cb(err);
      }
      if (response.statusCode >= 400) {
        return cb(util.format("Code %s from %s", response.statusCode, url));
      }
      return cb(null, body);
    });
  }, function (err) {
    if (err) {
      log.error("Error setting MOTD:", err);
      res.send(500, err);
    }
    res.send(200, req.body.msg);
  });
};

/*jslint unparam: true */
Server.prototype.handle_get_stats = function (req, res) {
  var self = this,
    stats = {
      colabs: {},
      last_replication: self.controller.last_rep,
      workspaces: self.controller.workspace_stats
    };

  stats.actions = _.map(_.filter(self.controller.workspaces, function (w) {
    return !!w.action && !!w.action.to;
  }), function (w) {
    return w.action;
  });

  stats.action_history = self.controller.action_history;
  stats.active_workspaces = {};
  _.each(self.controller.server_mapping.workspace, function (server, workspace_id) {
    stats.active_workspaces[server.id] = stats.active_workspaces[server.id] || [];
    stats.active_workspaces[server.id].push(workspace_id);
  });

  _.each(self.controller.colab_servers, function (c, cid) {
    stats.colabs[cid] = c.to_json();
    stats.colabs[cid].poller_errors = c.poller.errors;
    stats.colabs[cid].workspaces = _.size(_.filter(self.controller.workspaces, function (w) {
      return !!w.colabs[cid];
    }));
  });
  res.json(200, stats);
};
/*jslint unparam: false */

module.exports = Server;
