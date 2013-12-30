var fs = require("fs");
var http = require("http");
var https = require("https");
var util = require("util");

var async = require("async");
var express = require("express");
var log = require("floorine");
var request = require("request");
var _ = require("lodash");

var poll = require("./poll");
var settings = require("./settings");

request = request.defaults({
  sendImmediately: true
});

var AUTH_USER = settings.auth.username;
var AUTH_PASS = settings.auth.password;

/* TODO: split this file up!
   probably into separate files for http interface, polling, and ensuring repcount
 */

var ColabControlServer = function () {
  var self = this,
    active_count = _.size(_.where(settings.colab_servers, function (s) { return !s.exclude; })),
    auth = express.basicAuth(AUTH_USER, AUTH_PASS);

  if (!_.isFinite(settings.repcount) || settings.repcount < 1) {
    log.error("settings.repcount is invalid: %s!", settings.repcount);
    return process.exit(1);
  }

  if (settings.log_level !== "debug") {
    if (settings.repcount < 3) {
      log.error("Production server and repcount is less than 3. SHUT IT DOWN!");
      return process.exit(1);
    }
  }

  if (settings.repcount > active_count) {
    log.error("Repcount (%s) is greater than the number of available colab servers (%s)!", settings.repcount, settings.colab_servers.length);
    return process.exit(1);
  }

  self.server_mapping = {
    "token": {},
    "workspace": {},
    "username": {}
  };

  // {
  //   id: 10,
  //   servers: {
  //     1: {
  //       version: 100,
  //       active: false,
  //     },
  //     2: {
  //       version: 100,
  //       active: true,
  //     },
  //     3: {
  //       version: 99,
  //       active: false,
  //     },
  //   },
  // }
  self.workspaces = {};

  self.colab_servers = _.clone(settings.colab_servers);

  _.each(self.colab_servers, function (server, pos) {
    server.id = pos;
  });

  self.app = express();
  self.app.use(express.bodyParser());
  self.app.use(express.logger());

  self.poller = new poll.ColabPoller(self, settings.poll_interval);

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

  self.app.get("/r/:owner/:workspace", self.handle_get_workspace.bind(self));
  self.app.post("/r/:owner/:workspace", auth, self.handle_pin_workspace.bind(self));
  self.app.post("/r/:owner/:workspace/evict", auth, self.handle_pin_workspace.bind(self));
  self.app["delete"]("/r/:owner/:workspace", auth, self.handle_delete_workspace.bind(self));

  self.app.get("/t/:token", self.handle_request.bind(self, "token"));
  self.app.get("/u/:username", self.handle_request.bind(self, "username"));
  self.app.post("/motd", auth, self.handle_motd.bind(self));
  self.app.post("/wallops", auth, self.handle_wallops.bind(self));
};


ColabControlServer.prototype.start = function () {
  var self = this;

  log.log("Starting HTTP server on port", settings.http_port);
  self.server.listen(settings.http_port, function (err) {
    if (err) {
      log.error(err);
      return;
    }
    log.log("HTTP server listening on port", settings.http_port);
  });

  if (self.server_ssl) {
    log.log("Starting HTTPS server on port", settings.http_port);
    self.server_ssl.listen(settings.https_port, function (err) {
      if (err) {
        log.error(err);
        return;
      }
      log.log("HTTPS server listening on port", settings.https_port);
    });
  }

  self.poller.start();
};


ColabControlServer.prototype.find_server = function (namespace, key) {
  var self = this,
    colab_server = self.server_mapping[namespace][key],
    servers;

  if (colab_server) {
    log.debug("%s %s is on %s:%s", namespace, key, colab_server.ip, colab_server.colab_port);
    return {
      ip: colab_server.ip,
      port: colab_server.colab_port,
      ssl: colab_server.ssl
    };
  }

  servers = _.chain(self.colab_servers)
    .filter(function (server) { return !server.exclude; })
    .shuffle()
    .value();

  colab_server = _.find(servers, function (server) {
    var mem_free = server.memory.freemem / server.memory.totalmem,
      rss_used = server.memory.rss / server.memory.totalmem;
    return _.max(server.loadavg) < settings.busy.loadavg && mem_free > settings.busy.mem_free && rss_used < 0.7;
  });

  // Nothing good. just pick one
  if (colab_server) {
    log.debug("Picked %s:%s for %s %s", colab_server.ip, colab_server.colab_port, namespace, key);
  } else {
    colab_server = servers[0];
    log.warn("All servers are busy. Randomly picked %s:%s for %s %s", colab_server.ip, colab_server.colab_port, namespace, key);
  }

  self.server_mapping[namespace][key] = colab_server;

  return {
    ip: colab_server.ip,
    port: colab_server.colab_port,
    ssl: colab_server.ssl
  };
};

ColabControlServer.prototype.handle_request = function (namespace, req, res) {
  var self = this,
    data = self.find_server(namespace, req.params[namespace]);

  log.debug(data);
  res.json(200, data);
};

ColabControlServer.prototype.handle_get_workspace = function (req, res) {
  var self = this,
    data,
    key = util.format("%s/%s", req.params.owner, req.params.workspace);

  data = self.find_server("workspace", key);

  res.json(200, data);
};

ColabControlServer.prototype.handle_evict_workspace = function (req, res) {
  var self = this,
    key = util.format("%s/%s", req.params.owner, req.params.workspace),
    server = self.server_mapping.workspace[key];

  if (!server) {
    return res.json(404, {error: util.format("Server not found for workspace %s. Probably inactive.", key)});
  }

  return self.evict_workspace(server, req.params.owner, req.params.workspace, function (err, result) {
    if (err) {
      return res.send(err, result);
    }
    res.send(204);
  });
};

ColabControlServer.prototype.handle_delete_workspace = function (req, res) {
  var self = this,
    key = util.format("%s/%s", req.params.owner, req.params.workspace),
    server = self.server_mapping.workspace[key];

  if (!server) {
    return res.json(404, {error: util.format("Server not found for workspace %s", key)});
  }

  return self.delete_workspace(server, req.params.owner, req.params.workspace, function (err, result) {
    if (err) {
      return res.send(err, result);
    }
    res.send(204);
  });
};

ColabControlServer.prototype.handle_pin_workspace = function (req, res) {
  var self = this,
    key = util.format("%s/%s", req.params.owner, req.params.workspace),
    name = req.body.name,
    old_server,
    server;

  if (!name) {
    return res.json(400, {error: "Bad request. Need server name."});
  }

  server = _.where(self.colab_servers, {"name": name})[0];

  if (!server) {
    return res.json(404, {error: util.format("No server named %s", name)});
  }

  log.log("Pinned workspace %s to server %s (%s:%s)", key, server.name, server.ip, server.colab_port);

  old_server = self.server_mapping.workspace[key];
  self.server_mapping.workspace[key] = server;

  if (!old_server) {
    return res.json(200, server);
  }

  return self.delete_workspace(old_server, req.params.owner, req.params.workspace, function (err, result) {
    if (err) {
      return res.send(err, result);
    }
    return res.json(200, server);
  });
};

ColabControlServer.prototype.handle_wallops = function (req, res) {
  var self = this;

  log.warn("Wallops:", req.body.msg);
  if (!req.body.msg) {
    log.error("No message. Bad wallops request.");
    return res.send(400, "NEED A MESSAGE");
  }

  async.each(self.colab_servers, function (colab_server, cb) {
    var options = {
        auth: {
          user: AUTH_USER,
          password: AUTH_PASS
        },
        json: req.body,
        rejectUnauthorized: false
      },
      url = util.format("%s://%s:%s/wallops", (colab_server.ssl ? "https" : "http"), colab_server.ip, colab_server.command_port);

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

ColabControlServer.prototype.handle_motd = function (req, res) {
  var self = this;

  log.warn("MOTD:", req.body);
  async.each(self.colab_servers, function (colab_server, cb) {
    var options = {
        auth: {
          user: AUTH_USER,
          password: AUTH_PASS
        },
        json: req.body,
        rejectUnauthorized: false
      },
      url = util.format("%s://%s:%s/motd", (colab_server.ssl ? "https" : "http"), colab_server.ip, colab_server.command_port);

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

ColabControlServer.prototype.evict_workspace = function (server, owner, workspace, cb) {
  var options = {
      auth: {
        user: AUTH_USER,
        password: AUTH_PASS
      },
      json: true,
      rejectUnauthorized: false
    },
    url = util.format("%s://%s:%s/r/%s/%s/evict", (server.ssl ? "https" : "http"), server.ip, server.command_port, owner, workspace);

  request.post(url, options, function (err, response, body) {
    if (err) {
      log.error(err);
      return cb(500, err);
    }

    log.debug("Response from evict %s: %s", url, body);

    if (response.statusCode >= 400) {
      return cb(response.statusCode, util.format("Status code %s from %s", response.statusCode, url));
    }

    return cb(null, body);
  });
};

ColabControlServer.prototype.delete_workspace = function (server, owner, workspace, cb) {
  var options = {
      auth: {
        user: AUTH_USER,
        password: AUTH_PASS
      },
      json: true,
      rejectUnauthorized: false
    },
    url = util.format("%s://%s:%s/r/%s/%s", (server.ssl ? "https" : "http"), server.ip, server.command_port, owner, workspace);

  request.del(url, options, function (err, response, body) {
    if (err) {
      log.error(err);
      return cb(500, err);
    }

    log.debug("Response from DELETE %s: %s", url, body);

    if (response.statusCode >= 400) {
      return cb(response.statusCode, util.format("Status code %s from %s", response.statusCode, url));
    }

    return cb(null, body);
  });
};

ColabControlServer.prototype.delete_workspace_by_id = function (server, workspace_id, cb) {
  var options = {
      auth: {
        user: AUTH_USER,
        password: AUTH_PASS
      },
      json: true,
      rejectUnauthorized: false
    },
    url = util.format("%s://%s:%s/workspace/%s", (server.ssl ? "https" : "http"), server.ip, server.command_port, workspace_id);

  cb = cb || function (err) {
    if (err) {
      log.error(err);
    }
  };

  request.del(url, options, function (err, response, body) {
    if (err) {
      log.error(err);
      return cb(500, err);
    }

    log.debug("Response from DELETE %s: %s", url, body);

    if (response.statusCode >= 400) {
      return cb(response.statusCode, util.format("Status code %s from %s", response.statusCode, url));
    }

    return cb(null, body);
  });
};


ColabControlServer.prototype.drain = function (server) {
  var self = this,
    filtered_mapping = {};

  server.exclude = true;

  // TODO: kick users on drained server? not sure
  _.each(self.server_mapping, function (mapping, key) {
    filtered_mapping[key] = _.filter(mapping, function (v) {
      return v.ip === server.ip;
    });
  });
  self.server_mapping = filtered_mapping;
};


ColabControlServer.prototype.stop = function () {
  var self = this;

  // TODO: save state to disk?
  self.poller.stop();

  try {
    log.log("Closing HTTP server...");
    self.server.close();
    log.log("Done closing HTTP server.");
  } catch (e) {
    log.error("Error closing HTTP server:", e);
  }

  if (self.server_ssl) {
    try {
      log.log("Closing HTTPS server...");
      self.server_ssl.close();
      log.log("Done closing HTTPS server.");
    } catch (e2) {
      log.error("Error closing HTTPS server:", e2);
    }
  }
};


exports.run = function () {
  var server;

  log.set_log_level(settings.log_level);

  server = new ColabControlServer();

  function shut_down(sig) {
    log.log("caught signal: ", sig);
    server.stop();
    process.exit(0);
  }

  process.on("SIGTERM", function () {shut_down("SIGTERM"); });
  process.on("SIGINT", function () {shut_down("SIGINT"); });

  process.on("SIGHUP", function (sig) {
    log.warn("Got SIGHUP", sig);
    delete require.cache[require.resolve("./settings")];
    settings = require("./settings");
  });

  log.log("Polling servers...");
  server.poller.poll(function (err) {
    if (err) {
      process.exit(1);
    }
    server.start();
  });
};
