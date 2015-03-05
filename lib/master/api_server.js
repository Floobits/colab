/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var fs = require("fs");
var http = require("http");
var https = require("https");
var util = require("util");

var async = require("async");
var bodyParser = require("body-parser");
var express = require("express");
var log = require("floorine");
var morgan = require("morgan");
var _ = require("lodash");

var db = require("./db");
var settings = require("../settings");
var utils = require("../utils");


var Server = function (controller) {
  var self = this,
    auth = utils.basic_auth(settings.auth.username, settings.auth.password);

  self.listening = false;
  self.controller = controller;
  self.app = express();
  self.app.use(bodyParser.json());
  self.app.use(morgan("dev"));
  self.app.set("view cache", false);
  self.app.set("etag", false);

  /*eslint-disable no-sync */
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
  /*eslint-enable no-sync */

  if (settings.https_port) {
    log.log("HTTPS enabled on port", settings.https_port);
    self.server_ssl = https.createServer({
      ca: self.ca,
      cert: self.cert,
      key: self.key,
      ciphers: settings.ciphers,
      honorCipherOrder: true
    }, self.app);
  }

  self.server = http.createServer(self.app);

  self.app.get("/p/:path", self.handle_get_workspace_by_path.bind(self));
  self.app.get("/p/:owner/:workspace", self.handle_get_workspace_by_name.bind(self));
  self.app.get("/r/:owner/:workspace", self.handle_get_workspace_by_name.bind(self));
  self.app.get("/t/:token", self.handle_request.bind(self, "token"));
  self.app.get("/u/:username", self.handle_request.bind(self, "username"));
  self.app.get("/workspace/:workspace_id", self.handle_get_workspace.bind(self));

  /* Everything below this should require auth. */

  self.app.get("/stats", auth, self.handle_get_stats.bind(self));
  self.app.get("/colab/:colab_name", auth, self.handle_colab_get.bind(self));

  self.app.post("/colab/:colab_name/drain", auth, self.handle_drain.bind(self));
  self.app.delete("/r/:owner/:workspace", auth, self.handle_delete_workspace_by_name.bind(self));
  self.app.delete("/workspace/:workspace_id", auth, self.handle_delete_workspace.bind(self));
  self.app.post("/workspace/:workspace_id/pin", auth, self.handle_pin_workspace.bind(self));
  self.app.post("/workspace/:workspace_id/evict", auth, self.handle_evict_workspace.bind(self));
  self.app.post("/motd", auth, self.handle_motd.bind(self));
  self.app.post("/wallops", auth, self.handle_wallops.bind(self));
};

Server.prototype.listen = function (listen_cb) {
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
      log.log("Starting HTTPS server on port", settings.https_port);
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

  async.auto(auto, function (err, result) {
    self.listening = true;
    return listen_cb(err, result);
  });
};

Server.prototype.stop = function (stop_cb) {
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

  async.auto(auto, function (err, result) {
    self.listening = false;
    return stop_cb(err, result);
  });
};

Server.prototype.handle_request = function (namespace, req, res) {
  var self = this,
    data = self.controller.find_server(namespace, req.params[namespace]);

  log.debug(data);
  res.status(200).json(data);
};

Server.prototype.handle_get_workspace = function (req, res, create) {
  var self = this,
    workspace_id = req.params.workspace_id,
    colab = self.controller.server_mapping.workspace[workspace_id],
    workspace = self.controller.workspaces[workspace_id];

  if (colab) {
    return res.status(200).json(colab.conn_info());
  }

  if (!workspace) {
    if (!create) {
      return res.status(500).end();
    }
    // Lame special case. whatever.
    return self.controller.create_workspace(workspace_id, function (err, w) {
      if (err) {
        return res.status(500).send(err);
      }
      log.log("Created workspace %s", workspace_id);
      colab = _.keys(w.slaves)[0];
      colab = self.controller.slaves[colab];
      self.controller.set_mapping(workspace_id, colab);
      return res.status(200).json(colab.conn_info());
    });
  }

  try {
    colab = self.controller.get_source(workspace);
  } catch (e) {
    return res.status(404).end();
  }

  self.controller.set_mapping(workspace_id, colab);
  return res.status(200).json(colab.conn_info());
};

Server.prototype.handle_get_workspace_by_name = function (req, res) {
  var self = this,
    owner = req.params.owner,
    workspace = req.params.workspace;

  db.get_workspace(owner, workspace, function (err, result) {
    if (err) {
      if (result && result.rowCount === 0) {
        return res.status(404).end();
      }
      log.error("Error finding workspace %s/%s: %s", owner, workspace, err);
      return res.status(500).send(err);
    }
    self.handle_get_workspace({ params: { workspace_id: result.id }}, res, true);
  });
};

Server.prototype.handle_get_workspace_by_path = function (req, res) {
  var self = this,
    path_parts = req.params.path.split("/"),
    owner = path_parts[0],
    workspace = path_parts[1];

  if (path_parts.length === 1) {
    workspace = "";
  } else if (path_parts.length > 2) {
    return res.status(400).send("Can't parse path");
  }
  db.get_workspace(owner, workspace, function (err, result) {
    if (err) {
      if (result && result.rowCount === 0) {
        return res.status(404).end();
      }
      log.error("Error finding workspace %s/%s: %s", owner, workspace, err);
      return res.status(500).send(err);
    }
    self.handle_get_workspace({ params: { workspace_id: result.id }}, res, true);
  });
};

Server.prototype.handle_evict_workspace = function (req, res) {
  var self = this,
    key = util.format("%s", req.params.workspace_id),
    server = self.controller.server_mapping.workspace[key];

  if (!server) {
    return res.status(404).json({error: util.format("Server not found for workspace %s. Probably inactive.", key)});
  }

  return server.workspace(req.params.workspace_id, "evict", {}, function (err) {
    if (err) {
      return res.status(500).send(err);
    }
    res.status(204).end();
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
      return res.status(500).send(err);
    }
    return self.handle_delete_workspace({ params: { workspace_id: result.id }}, res);
  });
};

Server.prototype.handle_delete_workspace = function (req, res) {
  var self = this,
    colabs,
    workspace_id = req.params.workspace_id,
    workspace = self.controller.workspaces[workspace_id];

  if (!workspace || !workspace.slaves || _.size(workspace.slaves) === 0) {
    return res.status(404).json({error: util.format("Server not found for workspace %s", workspace_id)});
  }

  /*jslint unparam: true */
  colabs = _.map(workspace.slaves, function (colab, colab_id) {
    return self.controller.slaves[colab_id];
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
      return res.status(500).send(err);
    }
    return res.status(204).end();
  });
};

Server.prototype.handle_pin_workspace = function (req, res) {
  var self = this,
    key = util.format("%s", req.params.workspace_id),
    name = req.body.name,
    old_server,
    server;

  if (!name) {
    return res.status(400).json({error: "Bad request. Need server name."});
  }

  server = _.where(self.controller.slaves, {"name": name})[0];

  if (!server) {
    return res.status(404).json({error: util.format("No server named %s", name)});
  }

  log.log("Pinned workspace %s to slave %s (%s:%s)", key, server.toString(), server.ip, server.colab_port);

  old_server = self.controller.server_mapping.workspace[key];
  self.controller.set_mapping(key, server);

  if (!old_server) {
    return res.status(200).json(server.to_json());
  }

  return old_server.workspace(req.params.workspace_id, "evict", {}, function (err) {
    if (err) {
      return res.status(500).send(err);
    }
    return res.status(200).json(server.to_json());
  });
};

Server.prototype.handle_wallops = function (req, res) {
  var self = this,
    wallops = req.body.msg;

  if (!wallops) {
    log.error("No message. Bad wallops request.");
    return res.status(400).send("NEED A MESSAGE");
  }

  log.warn("Wallops:", wallops);

  self.controller.async_each_slave(function (slave, cb) {
    slave.wallops(wallops, cb);
  }, function (err) {
    if (err) {
      log.error("Error setting wallops:", err);
      res.status(500).send(err);
    }
    res.status(200).send(wallops);
  });
};

Server.prototype.handle_motd = function (req, res) {
  var self = this,
    motd = req.body;

  log.warn("MOTD:", req.body);

  // TODO: save MOTD to server db
  self.controller.async_each_slave(function (slave, cb) {
    slave.motd(motd, cb);
  }, function (err) {
    if (err) {
      log.error("Error setting MOTD:", err);
      res.status(500).send(err);
    }
    res.status(200).send(motd);
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
    if (!server) {
      log.error("No server mapping for workspace %s", workspace_id);
      return;
    }
    stats.active_workspaces[server.id] = stats.active_workspaces[server.id] || [];
    stats.active_workspaces[server.id].push(workspace_id);
  });

  _.each(self.controller.slaves, function (c, cid) {
    stats.colabs[cid] = c.to_json();
    stats.colabs[cid].disconnected = c.disconnected;
    stats.colabs[cid].workspaces = _.size(_.filter(self.controller.workspaces, function (w) {
      return !!w.slaves[cid];
    }));
  });
  return res.status(200).json(stats);
};
/*jslint unparam: false */

Server.prototype.handle_colab_get = function (req, res) {
  var self = this,
    colab = self.controller.slaves[req.params.colab_name],
    stats = {};

  if (!colab) {
    return res.status(404).end();
  }

  stats = colab.to_json();
  stats.disconnected = colab.disconnected;
  stats.workspaces = _.size(_.filter(self.controller.workspaces, function (w) {
    return !!w.slaves[colab.id];
  }));

  return res.status(200).json(stats);
};

Server.prototype.handle_drain = function (req, res) {
  var self = this,
    colab = self.controller.slaves[req.params.colab_name];

  if (!colab) {
    return res.status(404).end();
  }

  self.controller.drain(colab);
  return res.status(204).end();
};


module.exports = Server;
