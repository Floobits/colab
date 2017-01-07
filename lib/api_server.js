"use strict";

const http = require("http");
const https = require("https");
const util = require("util");

const _ = require("lodash");
const async = require("async");
const bodyParser = require("body-parser");
const express = require("express");
const log = require("floorine");
const morgan = require("morgan");

const api_client = require("./api_client");
const buffer = require("./buffer");
const ldb = require("./ldb");
const settings = require("./settings");
const utils = require("./utils");
const slave = require("./slave/slave");


const Server = function (server, controller) {
  const self = this;
  const auth = utils.basic_auth(settings.auth.username, settings.auth.password);

  self.listening = false;
  self.set_controller(controller);

  const app = express();
  app.use(bodyParser.json());
  app.use(morgan("dev"));
  app.set("view cache", false);
  app.set("etag", false);

  if (settings.https_port && server.cert && server.key) {
    log.log("HTTPS enabled on port", settings.https_port);
    self.server_ssl = https.createServer({
      ca: server.ca,
      cert: server.cert,
      key: server.key,
      ciphers: settings.ciphers,
      honorCipherOrder: true,
    }, app);
  } else {
    log.warn("Missing cert info or https_port setting. API will only be available over insecure HTTP.");
  }

  log.log("HTTP enabled on port", settings.http_port);
  self.server = http.createServer(app);

  app.get("/p/:path", self.handle_get_workspace_by_path.bind(self));
  app.get("/p/:owner/:workspace", self.handle_get_workspace_by_name.bind(self));
  app.get("/r/:owner/:workspace", self.handle_get_workspace_by_name.bind(self));
  app.get("/t/:token", self.handle_request.bind(self, "token"));
  app.get("/u/:username", self.handle_request.bind(self, "username"));
  app.get("/workspace/:workspace_id", self.handle_get_workspace.bind(self));
  app.get("/workspace/:workspace_id/active", self.handle_get_active_workspace.bind(self));
  app.get("/workspaces/active", self.handle_get_active_workspaces.bind(self));
  app.get("/user/:username/now_editing", self.handle_get_user_now_editing.bind(self));
  app.get("/users/active", self.handle_get_active_users.bind(self));
  app.get("/tags/active", self.handle_get_active_tags.bind(self));

  // New URLs
  app.get("/local/workspaces/active", on_workspaces_active.bind(app, server));
  app.get("/local/workspaces/all", on_workspaces_all.bind(app, server));
  app.get("/local/workspace/:workspace_id/:buf_id", on_buf_get.bind(app, server));
  app.get("/local/workspace/:workspace_id", on_workspace_get.bind(app, server));

  /* Everything below this should require auth. */

  app.get("/stats", auth, self.handle_get_stats.bind(self));
  app.get("/colab/:colab_name", auth, self.handle_colab_get.bind(self));

  app.post("/colab/:colab_name/drain", auth, self.handle_drain.bind(self));
  // Delete workspace globally
  app.delete("/workspace/:workspace_id", auth, self.handle_delete_workspace.bind(self));
  // Delete locally only
  app.delete("/local/workspace/:workspace_id", auth, delete_workspace_by_id.bind(app, server));
  app.post("/workspace/:workspace_id/pin", auth, self.handle_pin_workspace.bind(self));
  app.post("/workspace/:workspace_id/evict", auth, self.handle_evict_workspace.bind(self));
  app.post("/motd", auth, self.handle_motd.bind(self));
  app.post("/wallops", auth, self.handle_wallops.bind(self));

  // In case we want to introspect this object later in a debugger or something
  self.app = app;
};

Server.prototype.set_controller = function (controller) {
  if (controller) {
    // enable master functionality
  } else {
    // disable master functionality
  }
  this.controller = controller;
};

Server.prototype.listen = function (listen_cb) {
  const self = this;
  const auto = {};

  auto.http_listen = function (cb) {
    log.log("Starting HTTP server on port", settings.http_port);
    self.server.listen(settings.http_port, function (err) {
      if (err) {
        log.error("Error starting HTTP server:", err);
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
          log.error("Error starting HTTPS server:", err);
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
  const self = this;

  if (!self.listening) {
    return stop_cb();
  }

  const auto = {};
  auto.close_server = function (cb) {
    log.log("Closing HTTP server...");
    self.server.close(function (err, result) {
      if (err) {
        log.error("ERROR CLOSING HTTP SERVER", err);
      }
      cb(err, result);
    });
  };

  if (self.server_ssl) {
    auto.close_ssl = function (cb) {
      log.log("Closing HTTPS server...");
      self.server_ssl.close(function (err, result) {
        if (err) {
          log.error("ERROR CLOSING HTTPS SERVER", err);
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

Server.prototype.handle_get_workspace = function (req, res) {
  return this._handle_get_workspace(req, res);
};

Server.prototype._handle_get_workspace = function (req, res, create) {
  const self = this;
  const workspace_id = parseInt(req.params.workspace_id, 10);
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
    self._handle_get_workspace({ params: { workspace_id: result.id }}, res, true);
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
    self._handle_get_workspace({ params: { workspace_id: result.id }}, res, true);
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

  const server = _.filter(self.controller.slaves, {"name": name})[0];
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


function on_workspaces_active(server, req, res) {
  const response = {};

  log.debug("%s asked for active workspaces", req.ip);

  response.workspaces = _.map(server.workspaces, function (workspace) {
    return {
      id: workspace.id,
      name: workspace.name,
      owner: workspace.owner,
      users: _.map(workspace.handlers, function (agent) {
        return {
          client: agent.client,
          user_id: agent.user_id,
          is_anon: agent.is_anon,
          platform: agent.platform,
          username: agent.username,
          version: agent.version
        };
      }),
      version: workspace.version
    };
  });

  return res.status(200).json(response);
}

function on_workspaces_all(server, req, res) {
  const auto = {};
  log.debug("%s asked for all workspaces", req.ip);

  auto.load = slave.get_load;

  auto.workspaces = slave.all_workspaces.bind(null, server);

  async.auto(auto, function (err, result) {
    const response = {};
    if (err) {
      return res.status(500).send(err);
    }
    response.server_id = server.id;
    response.load = result.load;
    response.workspaces = result.workspaces;
    return res.status(200).json(response);
  });
}

function on_workspace_get(server, req, res) {
  const workspace_id = parseInt(req.params.workspace_id, 10);

  slave.get_workspace(server, workspace_id, {}, function (err, result) {
    if (err) {
      if (err.type === "NotFoundError") {
        return res.status(404).end();
      }
      if (err.type === "OpenError") {
        // TODO: delete from server db?
        log.error("%s exists in server DB but not filesystem", workspace_id);
      }
      return res.status(500).send(err.toString());
    }
    return res.status(200).json(result);
  });
}

function on_buf_get(server, req, res) {
  const buf_id = parseInt(req.params.buf_id, 10);
  const workspace_id = parseInt(req.params.workspace_id, 10);
  const workspace = server.workspaces[workspace_id];

  const on_buf_load = (err, buf) => {
    if (err) {
      if (err.type === "NotFoundError") {
        return res.status(404).end();
      }
      if (err.type === "OpenError" && err.message && err.message.indexOf("No such file or directory") !== -1) {
        return res.status(404).end();
      }
      // TODO: detect empty buf error and send
      // Empty buffer
      // return res.send(new Buffer(0));
      return res.status(500).send(err.toString());
    }
    res.type(buf.get_content_type());
    return res.status(200).send(buf._state);
  };

  // TODO: check etag. send content Content-MD5 header
  if (workspace) {
    let buf = workspace.bufs[buf_id];
    if (!buf || buf.deleted) {
      return res.status(404).end();
    }
    if (buf.load_state === buffer.LOAD_STATES.LOADED) {
      res.type(buf.get_content_type());
      return res.status(200).send(buf._state);
    }
    buf.load(on_buf_load);
    return;
  }

  const auto = {};
  auto.db = function (cb) {
    ldb.get_db(null, workspace_id, null, cb);
  };

  auto.buf = ["db", function (cb, result) {
    ldb.get(result.db, workspace_id, util.format("buf_%s", buf_id), "json", cb);
  }];

  auto.buf_load = ["buf", function (cb, result) {
    if (result.buf.deleted) {
      // So we'll send back a 404
      return cb({
        type: "NotFoundError",
      });
    }
    // Hack so that buffer gets loaded the normal way
    const fake_room = {
      db: result.db,
    };
    try {
      const b = buffer.from_db(fake_room, result.buf);
      b.load(cb);
    } catch (e) {
      cb(e);
    }
  }];

  async.auto(auto, function (err, result) {
    if (result.db) {
      ldb.finish_db(result.db, workspace_id);
    }
    return on_buf_load(err, result.buf_load);
  });
}

function delete_workspace_by_id(server, req, res) {
  const workspace_id = parseInt(req.params.workspace_id, 10);

  let username;
  if (req.body && req.body.username) {
    username = req.body.username;
  }

  slave.delete_workspace(server, workspace_id, username, function (err, result) {
    if (err) {
      if (err.type === "NotFoundError") {
        return res.status(404).send(err);
      }
      log.error("Error deleting workspace %s: %s", workspace_id, err);
      return res.status(500).send(err.toString());
    }
    if (!result.exists) {
      return res.status(404).end();
    }
    return res.status(204).end();
  });
}


module.exports = Server;
