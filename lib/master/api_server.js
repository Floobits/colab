"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const util = require("util");

const _ = require("lodash");
const async = require("async");
const bodyParser = require("body-parser");
const express = require("express");
const log = require("floorine");
const morgan = require("morgan");

const api_client = require("../api_client");
const settings = require("../settings");
const utils = require("../utils");


const Server = function (controller) {
  const self = this;
  const auth = utils.basic_auth(settings.auth.username, settings.auth.password);

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
    log.log("Master HTTPS enabled on port", settings.https_port);
    self.server_ssl = https.createServer({
      ca: self.ca,
      cert: self.cert,
      key: self.key,
      ciphers: settings.ciphers,
      honorCipherOrder: true
    }, self.app);
  }

  log.log("Master HTTP enabled on port", settings.http_port);
  self.server = http.createServer(self.app);

  self.app.get("/p/:path", self.handle_get_workspace_by_path.bind(self));
  self.app.get("/p/:owner/:workspace", self.handle_get_workspace_by_name.bind(self));
  self.app.get("/r/:owner/:workspace", self.handle_get_workspace_by_name.bind(self));
  self.app.get("/t/:token", self.handle_request.bind(self, "token"));
  self.app.get("/u/:username", self.handle_request.bind(self, "username"));
  self.app.get("/workspace/:workspace_id", self.handle_get_workspace.bind(self));
  self.app.get("/workspace/:workspace_id/active", self.handle_get_active_workspace.bind(self));
  self.app.get("/workspaces/active", self.handle_get_active_workspaces.bind(self));
  self.app.get("/user/:username/now_editing", self.handle_get_user_now_editing.bind(self));
  self.app.get("/users/active", self.handle_get_active_users.bind(self));
  self.app.get("/tags/active", self.handle_get_active_tags.bind(self));

  /* Everything below this should require auth. */

  self.app.get("/stats", auth, self.handle_get_stats.bind(self));
  self.app.get("/colab/:colab_name", auth, self.handle_colab_get.bind(self));

  self.app.post("/colab/:colab_name/drain", auth, self.handle_drain.bind(self));
  self.app.delete("/workspace/:workspace_id", auth, self.handle_delete_workspace.bind(self));
  self.app.post("/workspace/:workspace_id/pin", auth, self.handle_pin_workspace.bind(self));
  self.app.post("/workspace/:workspace_id/evict", auth, self.handle_evict_workspace.bind(self));
  self.app.post("/motd", auth, self.handle_motd.bind(self));
  self.app.post("/wallops", auth, self.handle_wallops.bind(self));
};

Server.prototype.listen = function (listen_cb) {
  const self = this;
  const auto = {};

  auto.http_listen = function (cb) {
    log.log("Starting master HTTP server on port", settings.http_port);
    self.server.listen(settings.http_port, function (err) {
      if (err) {
        log.error("Error starting master HTTP server:", err);
      } else {
        log.log("Master HTTP server listening on port", settings.http_port);
      }
      return cb(err);
    });
  };

  if (self.server_ssl) {
    auto.https_listen = function (cb) {
      log.log("Starting master HTTPS server on port", settings.https_port);
      self.server_ssl.listen(settings.https_port, function (err) {
        if (err) {
          log.error("Error starting master HTTPS server:", err);
        } else {
          log.log("Master HTTPS server listening on port", settings.https_port);
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
  const self = this;

  if (!self.listening) {
    return stop_cb();
  }

  const auto = {};
  auto.close_server = function (cb) {
    log.log("Closing master HTTP server...");
    self.server.close(function (err, result) {
      if (err) {
        log.error("ERROR CLOSING MASTER HTTP SERVER", err);
      }
      cb(err, result);
    });
  };

  if (self.server_ssl) {
    auto.close_ssl = function (cb) {
      log.log("Closing master HTTPS server...");
      self.server_ssl.close(function (err, result) {
        if (err) {
          log.error("ERROR CLOSING MASTER HTTPS SERVER", err);
        }
        cb(err, result);
      });
    };
  }

  async.auto(auto, function (err, result) {
    self.listening = false;
    return stop_cb(err, result);
  });
};

Server.prototype.handle_get_active_workspace = function (req, res) {
  const workspace_id = req.params.workspace_id;
  const server = this.controller.server_mapping.workspace[workspace_id];
  if (!server) {
    return res.status(404).end();
  }
  const workspace = this.controller.workspaces[workspace_id].slaves[server.id];
  return res.status(200).json(workspace);
};

Server.prototype.handle_get_active_workspaces = function (req, res) {
  const self = this;
  const workspaces = self.controller.workspaces;
  const active_workspaces = {};

  function add_workspace(workspace_id, server) {
    let workspace = workspaces[workspace_id].slaves[server.id];
    if (!workspace.users) {
      return;
    }
    active_workspaces[workspace_id] = {
      server: server.name,
      id: parseInt(workspace_id, 10),
      users: workspace.users
    };
  }

  if (req.params.ids) {
    _.each(req.params.ids, function (workspace_id) {
      let server = self.controller.server_mapping.workspace[workspace_id];
      if (server) {
        add_workspace(workspace_id, server);
      }
    });
  } else {
    _.each(self.controller.server_mapping.workspace, function (server, workspace_id) {
      add_workspace(workspace_id, server);
    });
  }

  return res.status(200).json(active_workspaces);
};

Server.prototype.active_users_each = function (f) {
  // TODO: stupidly inefficient
  _.each(this.controller.slaves, function (slave) {
    _.each(slave.active_workspaces, function (workspace) {
      _.each(workspace.users, function (user) {
        let user_id = user.user_id;
        if (user_id < 0) {
          return null;
        }
        return f(user, workspace);
      });
    });
  });
};

Server.prototype.handle_get_active_users = function (req, res) {
  const user_mapping = {};

  this.active_users_each(function (user, workspace) {
    if (_.has(user_mapping, user.id)) {
      user_mapping[user.id].push(workspace.id);
    } else {
      user_mapping[user.id] = [workspace.id];
    }
  });

  return res.status(200).json(user_mapping);
};

Server.prototype.handle_get_active_tags = function (req, res) {
  const active_tags = new Set();

  this.active_users_each(function (user) {
    for (let tag of user.tags) {
      active_tags.add(tag);
    }
  });

  return res.status(200).json(active_tags);
};

Server.prototype.handle_get_user_now_editing = function (req, res) {
  let data = [];
  const username = req.params.username;

  this.active_users_each(function (user, workspace) {
    if (user.username === username) {
      data.push(workspace.id);
      // Optimization. Break.
      return false;
    }
  });

  return res.status(200).json(data);
};

Server.prototype.handle_request = function (namespace, req, res) {
  const self = this;
  const data = self.controller.find_server(namespace, req.params[namespace]);

  log.debug(data);
  res.status(200).json(data);
};

Server.prototype.handle_get_workspace = function (req, res, create) {
  const self = this;
  const workspace_id = req.params.workspace_id;
  const workspace = self.controller.workspaces[workspace_id];

  let colab = self.controller.server_mapping.workspace[workspace_id];
  if (colab) {
    log.debug("Found active colab %s for workspace %s", colab.toString(), workspace_id);
    return res.status(200).json(colab.conn_info());
  }

  if (!workspace) {
    if (!create) {
      return res.status(500).end();
    }
    // Lame special case. whatever.
    return self.controller.create_workspace(workspace_id, function (err, w, slave) {
      if (err) {
        return res.status(500).send(err);
      }
      log.log("Created workspace", workspace_id, w);
      self.controller.set_mapping(workspace_id, slave);
      return res.status(200).json(slave.conn_info());
    });
  }

  try {
    colab = self.controller.get_source(workspace);
  } catch (e) {
    return res.status(404).end();
  }

  self.controller.set_mapping(workspace_id, colab);
  log.debug("Found inactive colab %s for workspace %s", colab.toString(), workspace_id);
  return res.status(200).json(colab.conn_info());
};

Server.prototype.handle_get_workspace_by_name = function (req, res) {
  const self = this;
  const owner = req.params.owner;
  const workspace = req.params.workspace;

  api_client.workspace_get(owner, workspace, function (err, result) {
    if (err) {
      let status = (result && result.statusCode) || 500;
      log.error("Error finding workspace %s/%s: %s", owner, workspace, err);
      return res.status(status).send(err);
    }
    self.handle_get_workspace({ params: { workspace_id: result.id }}, res, true);
  });
};

Server.prototype.handle_get_workspace_by_path = function (req, res) {
  const self = this;
  const path_parts = req.params.path.split("/");
  const owner = path_parts[0];
  let workspace = path_parts[1];

  if (path_parts.length === 1) {
    workspace = "";
  } else if (path_parts.length > 2) {
    return res.status(400).send("Can't parse path");
  }
  api_client.workspace_get(owner, workspace, function (err, result) {
    if (err) {
      let status = (result && result.statusCode) || 500;
      log.error("Error finding workspace %s/%s: %s", owner, workspace, err);
      return res.status(status).send(err);
    }
    self.handle_get_workspace({ params: { workspace_id: result.id }}, res, true);
  });
};

Server.prototype.handle_evict_workspace = function (req, res) {
  const self = this;
  const key = util.format("%s", req.params.workspace_id);
  const server = self.controller.server_mapping.workspace[key];
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

Server.prototype.handle_delete_workspace = function (req, res) {
  const self = this;
  const workspace_id = req.params.workspace_id;
  const workspace = self.controller.workspaces[workspace_id];
  if (!workspace || !workspace.slaves || _.size(workspace.slaves) === 0) {
    return res.status(404).json({error: util.format("Server not found for workspace %s", workspace_id)});
  }

  const colabs = _.map(workspace.slaves, function (colab, colab_id) {
    return self.controller.slaves[colab_id];
  });
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
  const self = this;
  const key = util.format("%s", req.params.workspace_id);

  const name = req.body.name;
  if (!name) {
    return res.status(400).json({error: "Bad request. Need server name."});
  }

  const server = _.where(self.controller.slaves, {"name": name})[0];
  if (!server) {
    return res.status(404).json({error: util.format("No server named %s", name)});
  }

  log.log("Pinned workspace %s to slave %s (%s:%s)", key, server.toString(), server.ip, server.colab_port);

  const old_server = self.controller.server_mapping.workspace[key];
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
  const self = this;
  const wallops = req.body.msg;
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
  const self = this;
  const motd = req.body;
  log.warn("MOTD:", motd);
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

Server.prototype.handle_get_stats = function (req, res) {
  const self = this;
  const stats = {
    colabs: {},
    last_replication: self.controller.last_rep,
    workspaces: self.controller.workspace_stats,
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
    stats.colabs[cid].error_count = c.error_count;
    stats.colabs[cid].error_list = c.error_list;
    stats.colabs[cid].disconnected = c.disconnected;
    stats.colabs[cid].workspaces = _.size(_.filter(self.controller.workspaces, function (w) {
      return !!w.slaves[cid];
    }));
  });
  return res.status(200).json(stats);
};

Server.prototype.handle_colab_get = function (req, res) {
  const self = this;
  const colab = self.controller.slaves[req.params.colab_name];

  if (!colab) {
    return res.status(404).end();
  }

  const stats = colab.to_json();
  stats.disconnected = colab.disconnected;
  stats.workspaces = _.size(_.filter(self.controller.workspaces, function (w) {
    return !!w.slaves[colab.id];
  }));

  return res.status(200).json(stats);
};

Server.prototype.handle_drain = function (req, res) {
  const self = this;
  const colab = self.controller.slaves[req.params.colab_name];
  if (!colab) {
    return res.status(404).end();
  }

  self.controller.drain(colab);
  return res.status(204).end();
};


module.exports = Server;
