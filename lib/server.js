var fs = require("fs");
var http = require("http");
var https = require("https");
var util = require("util");

var async = require("async");
var express = require("express");
var log = require("floorine");
var request = require("request");
var _ = require("lodash");

var colab = require("./colab");
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
  self.colab_servers = {};

  self.replicate_interval_id = null;

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

  self.replicate();
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

  return self.delete_workspace_by_name(server, req.params.owner, req.params.workspace, function (err, result) {
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

ColabControlServer.prototype.delete_workspace_by_name = function (server, owner, workspace, cb) {
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


ColabControlServer.prototype.duplicate_workspace = function (workspace, cb) {
  var self = this,
    colab,
    colab_id,
    dest,
    dest_id,
    options = {
      auth: {
        user: AUTH_USER,
        password: AUTH_PASS
      },
      rejectUnauthorized: false
    },
    source,
    source_id,
    url;

  /*jslint forin: true */
  for (colab_id in workspace.colabs) {
    colab = workspace.colabs[colab_id];
    if (!source) {
      source = colab;
      source_id = colab_id;
    }
    if (colab.active) {
      source_id = colab_id;
      break;
    }
    if (colab.version > source.version) {
      source = colab;
      source_id = colab_id;
    }
  }
  /*jslint forin: false */

  source = self.colab_servers[source_id];
  if (!source) {
    return cb(util.format("Couldn't find a source for %s", workspace.id));
  }

  _.each(workspace.colabs, function (colab, colab_id) {
    if (colab_id === source_id) {
      return;
    }
    if (!dest && colab.version < source.version) {
      dest = colab;
      dest_id = colab_id;
    }
    if (colab.version < dest.version) {
      dest = colab;
      dest_id = colab_id;
    }
  });

  if (!dest) {
    _.each(self.colab_servers, function (colab, colab_id) {
      if (_.contains(_.keys(workspace.colabs), colab_id)) {
        return;
      }
      if (!dest) {
        dest = colab;
        dest_id = colab_id;
      }
    });
  }

  dest = self.colab_servers[dest_id];
  if (!dest) {
    return cb(util.format("Couldn't find a destination for %s", workspace.id));
  }

  url = util.format("%s://%s:%s/fetch/%s", (dest.ssl ? "https" : "http"), dest.ip, dest.command_port, workspace.id);


  options.json = {
    ip: source.ip,
    port: source.command_port,
    proto: source.ssl ? "https" : "http"
  };

  cb = cb || function (err) {
    if (err) {
      log.error(err);
    }
  };

  request.post(url, options, function (err, response, body) {
    if (err) {
      log.error(err);
      return cb(500, err);
    }

    log.debug("Response from POST %s: %s", url, body);

    if (response.statusCode >= 400) {
      return cb(response.statusCode, util.format("Status code %s from %s", response.statusCode, url));
    }

    return cb(null, body);
  });
};


ColabControlServer.prototype.delete_workspace = function (workspace, cb) {
  var colab,
    options = {
      auth: {
        user: AUTH_USER,
        password: AUTH_PASS
      },
      json: true,
      rejectUnauthorized: false
    },
    url;

  workspace.action.running = true;

  _.each(_.shuffle(_.values(workspace.colabs)), function (candidate) {
    if (candidate.active) {
      return;
    }
    if (!colab) {
      colab = candidate;
      return;
    }
    if (candidate.version < colab.version) {
      colab = candidate;
      return;
    }
    // TODO: check disk usage, etc
  });

  if (!colab) {
    return cb(util.format("No candidate to delete %s from.", workspace.id));
  }

  url = util.format("%s://%s:%s/workspace/%s", (colab.ssl ? "https" : "http"), colab.ip, colab.command_port, workspace.id);

  cb = cb || function (err) {
    if (err) {
      log.error(err);
    }
  };

  request.del(url, options, function (err, response, body) {
    delete workspace.action;

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


ColabControlServer.prototype.replicate = function () {
  var self = this,
    action_workspaces = {},
    completed_actions = 0,
    priorities,
    prioritized_actions = [],
    stats = {
      correct: 0,
      high: 0,
      low: 0,
      running: 0
    };

  self.replicate_interval_id = null;
  self.replicating = true;

  // log.debug(self.workspaces);
  _.each(self.workspaces, function (w, id) {
    var priority,
      repcount = _.size(w.colabs);

    if (w.action && w.action.running) {
      log.log("Action is running for %s", id);
      stats.running++;
      return;
    }

    if (repcount < settings.repcount) {
      stats.low++;
      log.debug("Workspace %s has %s replicas (not enough).", id, repcount);
      // TODO: favor server with the least disk used
      // TODO: store pending replications so they aren't repeated
      w.action = {f: self.duplicate_workspace, running: false};
    } else if (repcount > settings.repcount) {
      stats.high++;
      log.debug("Workspace %s has %s replicas (too many).", id, repcount);
      w.action = {f: self.delete_workspace, running: false};
    } else {
      stats.correct++;
      log.debug("Workspace %s has the correct number of replicas (%s)", id, repcount);
      delete w.action;
    }
    if (w.action) {
      priority = Math.abs(repcount - settings.repcount) + !!_.findWhere(w.colabs, { active: true });
      action_workspaces[priority] = action_workspaces[priority] || [];
      action_workspaces[priority].push(w);
    }
  });
  log.log("Workspace replication counts: %s running. %s low. %s high. %s correct.", stats.running, stats.low, stats.high, stats.correct);

  priorities = _.keys(action_workspaces).sort(function (a, b) { return a - b; });

  _.each(priorities, function (p) {
    prioritized_actions = prioritized_actions.concat(_.shuffle(action_workspaces[p]));
  });

  setImmediate(function () {
    _.eachLimit(prioritized_actions, 20, function (w, cb) {
      if (self.replicating) {
        return cb("Another replication started.");
      }
      w.action.f.call(self, w, function (err) {
        if (err) {
          log.error("Error in action on workspace %s: %s", w.id, err);
        }
        completed_actions++;
        cb();
      });
    }, function (err) {
      log.log("Ran %s/%s actions.", completed_actions, action_workspaces.length);

      if (err) {
        log.log(err);
        return;
      }
      self.replicate_interval_id = setTimeout(self.replicate.bind(self), 5000);
    });
  });

  self.replicating = false;
};


ColabControlServer.prototype.stop = function () {
  var self = this;

  // TODO: save state to disk?
  _.each(self.colab_servers, function (colab) {
    colab.poller.stop();
  });

  if (self.replicate_interval_id) {
    clearTimeout(self.replicate_interval_id);
  }

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
  var colabs = [],
    controller;

  log.set_log_level(settings.log_level);

  controller = new ColabControlServer();

  function shut_down(sig) {
    log.log("caught signal: ", sig);
    controller.stop();
    process.exit(0);
  }

  process.on("SIGTERM", function () {shut_down("SIGTERM"); });
  process.on("SIGINT", function () {shut_down("SIGINT"); });

  process.on("SIGHUP", function (sig) {
    log.warn("Got SIGHUP", sig);
    delete require.cache[require.resolve("./settings")];
    settings = require("./settings");
    // TODO: refresh controller.colab_servers
  });

  log.log("Polling servers...");

  _.each(settings.colab_servers, function (colab_settings) {
    colabs.push(new colab.Colab(controller, colab_settings));
  });

  async.each(colabs, function (colab, cb) {
    colab.poller.start(function (err) {
      if (!err) {
        controller.colab_servers[colab.id] = colab;
      }
      cb(err);
    });
  }, function (err) {
    if (err) {
      // TODO: fixme
      process.exit(1);
    }
    controller.start();
  });
};
