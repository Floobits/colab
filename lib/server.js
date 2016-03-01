"use strict";

const net = require("net");
const os = require("os");
const path = require("path");
const tls = require("tls");
const util = require("util");

const _ = require("lodash");
const async = require("async");
const fs = require("fs-extra");
const levelup = require("levelup");
const log = require("floorine");
let heapdump;
try {
  heapdump = require("heapdump");
} catch (e) {
  log.error("Couldn't require heapdump:", e);
}

const settings = require("./settings");

const actions = require("./actions");
const api_client = require("./api_client");
const APIServer = require("./api_server");
const FloobitsProtocol = require("./protocol/floobits");
const ldb = require("./ldb");
const master_server = require("./master/master");
const MasterProtocol = require("./protocol/master");
const room = require("./room");

const Room = room.Room;
const ProRoom = room.ProRoom;
const ROOM_STATES = room.STATES;
const ROOM_STATES_REVERSE = room.STATES_REVERSE;

const INITIAL_RECONNECT_DELAY = 100;
const MAX_RECONNECT_DELAY = 10000;


const ColabServer = function () {
  const self = this;
  let tls_options;

  self.slaves = [];
  self.conn_number = 0;
  self.agents = {};
  self.workspaces = {};
  self.handlers = {};
  self.ca = null;
  self.hostname = os.hostname();
  self.server = net.createServer(function (conn) {
    self.on_conn(conn, false);
  });
  actions.conn.onEND(self.on_conn_end, this);
  actions.conn.onHANDLER(self.on_handler, this);
  actions.room.onADD_AGENT(self.on_add_agent, this);
  actions.room.onADD_COLAB(self.on_add_colab, this);
  actions.room.onADD(function (id, workspace) {
    self.workspaces[id] = workspace;
  }, this);
  actions.room.onREMOVE(function (id) {
    delete self.workspaces[id];
  }, this);

  /*eslint-disable no-sync */
  if (settings.json_port_ssl) {
    self.cert = fs.readFileSync(settings.ssl_cert);
    self.key = fs.readFileSync(settings.ssl_key);
    if (settings.ssl_ca) {
      self.ca = [];
      _.each(settings.ssl_ca, function (filename) {
        self.ca.push(fs.readFileSync(filename));
      });
    }
    tls_options = {
      ca: self.ca,
      cert: self.cert,
      key: self.key,
      // TODO: try to get this list of cipher suites as close to apache's as possible
      ciphers: "ECDHE-RSA-AES256-SHA384:EDH:AESGCM:AES256-SHA256:RC4-SHA:RC4:HIGH:!MD5:!aNULL",
      honorCipherOrder: true
    };
  }

  fs.mkdirsSync(settings.base_dir);
  settings.bufs_dir = path.join(settings.base_dir, "bufs");
  fs.mkdirsSync(settings.bufs_dir);
  settings.server_db_dir = path.join(settings.base_dir, "server_db");
  fs.mkdirsSync(settings.server_db_dir);
  settings.repos_dir = path.join(settings.base_dir, "repos");
  fs.mkdirsSync(settings.repos_dir);
  if (settings.ssh_pubkey && settings.ssh_privkey) {
    settings.ssh_key_path = path.join(settings.base_dir, "id_rsa_floobot");
    settings.ssh_wrapper_path = settings.ssh_key_path + ".sh";
    fs.writeFileSync(settings.ssh_key_path, settings.ssh_privkey);
    fs.chmodSync(settings.ssh_key_path, "600");
    fs.writeFileSync(settings.ssh_key_path + ".pub", settings.ssh_pubkey);
    fs.chmodSync(settings.ssh_key_path + ".pub", "600");
    log.log("SSH keys written to %s", settings.ssh_key_path);
    // Disable StrictHostKeyChecking because ssh has no trust on first use. Super lame.
    fs.writeFileSync(settings.ssh_wrapper_path,
      util.format("#!/bin/sh\nssh -i '%s' -o StrictHostKeyChecking=no \"$@\"\n", settings.ssh_key_path));
    fs.chmodSync(settings.ssh_wrapper_path, "755");
  } else {
    log.warn("No SSH key info. Repo pulling may not work.");
  }
  /*eslint-enable no-sync */

  if (settings.json_port_ssl) {
    log.log("JSON SSL enabled on port", settings.json_port_ssl);
    self.server_ssl = tls.createServer(tls_options, function (conn) {
      return self.on_conn(conn, true);
    });
  }

  self.slave = new MasterProtocol(self.conn_number);
  self.master_reconnect_delay = INITIAL_RECONNECT_DELAY;
  self.master_reconnect_timeout = null;

  function broadcast_if_connected(req, cb) {
    if (!self.slave.handler) {
      return new Error("Not connected to master!");
    }
    self.slave.handler.broadcast(req, cb);
  }

  actions.broadcast.onSEND_TO_MASTER(function (type, data, cb) {
    broadcast_if_connected(type, data, cb);
  });
  actions.broadcast.onSEND_TO_PATH(function (from, to, data, cb) {
    const req = {
      action: "to_path",
      from: from,
      to: to,
      data: data,
    };
    broadcast_if_connected(req, cb);
  });
  actions.broadcast.onSEND_TO_USER(function (from, to, data, cb) {
    const req = {
      action: "to_user",
      from: from,
      to: to,
      data: data,
    };
    broadcast_if_connected(req, cb);
  });
  actions.broadcast.onSOLICIT(function (from, data, cb) {
    const req = {
      action: "solicit",
      from: from,
      data: data,
    };
    broadcast_if_connected(req, cb);
  });

};

ColabServer.prototype.listen = function (cb) {
  const self = this;
  self.server.listen(settings.json_port);
  log.log("JSON protocol listening on port", settings.json_port);

  if (self.server_ssl) {
    self.server_ssl.listen(settings.json_port_ssl, cb);
    log.log("JSON SSL protocol listening on port", settings.json_port_ssl);
    return;
  }
  log.log("No JSON SSL.");
  self.server_ssl = {server: null};
  cb();
};

ColabServer.prototype.master_connect = function (cb) {
  const self = this;

  // TODO: total hack here
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const options = {
    port: settings.colab_master.port,
    host: settings.colab_master.ip
  };

  cb = cb || function () { return; };
  cb = _.once(cb);
  self.master_reconnect_timeout = null;

  log.log("Connecting to master (%s:%s)", settings.colab_master.ip, settings.colab_master.port);

  try {
    const cleartext_stream = tls.connect(options, function () {
      log.log("Connection established to master (%s:%s)", settings.colab_master.ip, settings.colab_master.port);
      self.slave = new MasterProtocol(++self.conn_number);
      self.slave.once("close", self.master_reconnect.bind(self));
      self.slave.init_conn(cleartext_stream, true);
      self.slave.handler.auth(self);
      self.master_reconnect_delay = INITIAL_RECONNECT_DELAY;
      cb();
    });
    cleartext_stream.setEncoding("utf8");
    cleartext_stream.on("error", function (err) {
      log.error("Error on master connection!", err);
      self.master_reconnect();
    });
  } catch (e) {
    log.warn(e);
    self.master_reconnect();
    return cb();
  }
};

ColabServer.prototype.master_reconnect = function () {
  const self = this;
  if (self.master_reconnect_timeout) {
    return;
  }
  log.log("Reconnecting to master in %sms", self.master_reconnect_delay);
  self.master_reconnect_timeout = setTimeout(self.master_connect.bind(self), self.master_reconnect_delay);
  self.master_reconnect_delay = Math.min(self.master_reconnect_delay * 2, MAX_RECONNECT_DELAY);
};

ColabServer.prototype.on_conn = function (conn, is_ssl) {
  const self = this;
  conn.setNoDelay(true); // Disable Nagle algorithm
  conn.setEncoding("utf8");

  if (settings.conn_keepalive) {
    conn.setKeepAlive(true, settings.conn_keepalive);
  }

  const number = ++self.conn_number;
  log.debug("client %s connected from %s:%s", number, conn.remoteAddress, conn.remotePort);
  self.agents[number] = new FloobitsProtocol(number);
  self.agents[number].init_conn(conn, is_ssl);
};

ColabServer.prototype.on_handler = function (id, handler) {
  const self = this;
  self.handlers[id] = handler;
  if (handler.is_slave) {
    self.slaves.push(handler);
  }
};

ColabServer.prototype.on_conn_end = function (agent_conn) {
  const self = this;
  delete self.agents[agent_conn.id];
  delete self.handlers[agent_conn.id];
  log.log("Client %s removed.", agent_conn.toString());
};

ColabServer.prototype.load_workspace = function (agent, id, api_workspace, cb) {
  const self = this;

  let atts;
  if (api_workspace) {
    atts = {
      name: api_workspace.name,
      owner: api_workspace.owner,
      cur_fid: api_workspace.cur_fid,
      max_size: api_workspace.max_size,
      secret: api_workspace.secret,
      repo_info: api_workspace.repo_info,
      private_github_url: api_workspace.private_github_url,
      created_at: api_workspace.created_at,
      updated_at: api_workspace.updated_at,
    };
  }

  let workspace = self.workspaces[id];
  if (workspace) {
    if (!workspace.atts && atts) {
      workspace.set_atts(atts);
    }
    if (workspace.state === ROOM_STATES.LOADING) {
      return workspace.once("load", function (err) {
        cb(err, workspace);
      });
    }
    if (workspace.state === ROOM_STATES.LOADED) {
      return cb(null, workspace);
    }
    return cb(util.format("This workspace is in state %s. No new connections allowed. Please try again shortly.",
              ROOM_STATES_REVERSE[workspace.state]));
  }
  let RoomClass = Room;
  if (api_workspace && api_workspace.pro) {
    RoomClass = ProRoom;
  }
  workspace = new RoomClass(id, atts, self);

  self.workspaces[id] = workspace;
  workspace.once("load", function (err) {
    cb(err, workspace);
  });
  workspace.load(agent);
};

ColabServer.prototype.on_add_agent = function (owner, name, agent, user, cb) {
  const self = this;

  function finish(err, workspace) {
    if (err) {
      log.error(err);
      return cb(err);
    }
    workspace.add_agent(agent, user, cb);
  }

  log.log("Adding agent %s for workspace %s owned by %s", agent.toString(), name, owner);

  api_client.workspace_get(owner, name, function (err, result) {
    if (err) {
      return cb(err);
    }
    log.log("Found workspace", result.id);
    log.debug("workspace_get response: %s", JSON.stringify(result));

    if (result === undefined) {
      log.error("Workspace id not found for", owner, name);
      return cb("Workspace not found");
    }
    self.load_workspace(agent, result.id, result, finish);
  });
};

ColabServer.prototype.on_add_colab = function (workspace_id, agent, cb) {
  const self = this;
  self.load_workspace(agent, workspace_id, null, function (err, workspace) {
    if (err) {
      log.error(err);
      return cb(err);
    }
    // TODO: Super hacky. Colab pretends to be a superuser.
    workspace.add_agent(agent, {
      id: -1,
      is_superuser: true,
    }, cb);
  });
};

ColabServer.prototype.save_state = function (save_cb) {
  const self = this;
  async.eachLimit(_.values(self.workspaces), 20, function (workspace, cb) {
    workspace.save_bufs(function () {
      setImmediate(cb);
    });
  }, function (err) {
    log.log("finished saving all state");
    return save_cb(err);
  });
};

ColabServer.prototype.wallops = function (msg) {
  const self = this;
  _.each(self.agents, function (a) {
    // Only send wallops to normal clients
    if (!a.handler || a.handler.is_slave) {
      return;
    }
    try {
      a.handler.error(null, msg, true);
    } catch (e) {
      log.error("Error sending wallops to %s: %s", a.handler.toString(), e);
    }
  });
};

ColabServer.prototype.disconnect = function (disconnect_cb) {
  const self = this;
  async.eachLimit(_.values(self.agents), 20, function (agent, cb) {
    agent.destroy();
    cb();
  }, function (err) {
    log.log("Everyone is disconnected");
    return disconnect_cb(err);
  });
};

ColabServer.prototype.stop_listening = function () {
  const self = this;
  // server.close() is supposed to take a callback, but it never seems to get fired :(
  log.log("Closing server...");
  try {
    self.server.close();
  } catch (e) {
    log.error("Couldn't close server:", e);
  }
  if (settings.json_port_ssl) {
    log.log("Closing ssl server...");
    try {
      self.server_ssl.close();
    } catch (e2) {
      log.error("Couldn't close ssl server:", e2);
    }
  } else {
    log.debug("No ssl server to close");
  }
};

exports.run = function () {
  log.set_log_level(settings.log_level);
  if (_.isUndefined(heapdump)) {
    log.error("No heapdump ability.");
  }
  let master;
  let server = new ColabServer();
  let api_server = new APIServer(server);

  function shut_down(sig) {
    log.log("Caught signal ", sig);
    clearTimeout(server.master_reconnect_timeout);
    server.stop_listening();
    async.series([
      function (cb) {
        if (master) {
          master.stop(cb);
        } else {
          cb();
        }
      },
      function (cb) {
        api_server.stop(cb);
      },
      server.disconnect.bind(server),
      server.save_state.bind(server),
    ], function (err) {
      if (err) {
        throw new Error(err);
      }
      /*eslint-disable no-process-exit */
      process.exit(0);
      /*eslint-enable no-process-exit */
    });
  }

  process.on("SIGTERM", function () {shut_down("SIGTERM"); });
  process.on("SIGINT", function () {shut_down("SIGINT"); });

  process.on("SIGUSR1", function () {
    log.log("Caught signal SIGUSR1. Saving state.");
    server.save_state(function () {
      log.log("Done saving state.");
    });
  });

  let auto = {};
  if (settings.is_master) {
    auto.master = function (cb) {
      master_server.run(function (err, result) {
        master = result;
        //TODO: Super hacky, but MasterHandler needs a reference to master
        server.master = master;
        cb(err, master);
      });
    };
  }

  auto.leveldb_open = function (cb) {
    log.log("Opening %s...", settings.server_db_dir);
    return levelup(settings.server_db_dir, {
      createIfMissing: true
    }, cb);
  };

  auto.get_server_id = ["leveldb_open", function (cb, response) {
    log.log("Opened %s.", settings.server_db_dir);
    response.leveldb_open.get("server_id", function (db_open_err, result) {
      if (!db_open_err) {
        return cb(null, result);
      }
      if (db_open_err.type !== "NotFoundError") {
        return cb(db_open_err);
      }
      const server_id = util.format("%s_%s", os.hostname(), ("00000" + (Math.random() * 100000)).slice(-6));
      return response.leveldb_open.put("server_id", server_id, function (err) {
        return cb(err, server_id);
      });
    });
  }];

  auto.listen = ["get_server_id", server.listen.bind(server)];

  auto.api_listen = ["listen", function (cb) {
    api_server.listen(cb);
  }];

  if (settings.colab_master) {
    auto.master_connect = ["listen", server.master_connect.bind(server)];
  }

  auto.workspace_stats = ["get_server_id", function (cb, response) {
    cb = _.once(cb);

    let stats = {
      bad_db: [],
      has_version: [],
      missing_dir: [],
      missing_version: [],
      ok: [],
      total: 0
    };

    const db = response.leveldb_open;
    server.db = db;
    server.id = response.get_server_id;
    log.log("Server ID is %s", server.id);

    const rs = db.createReadStream({
      start: "version_",
      end: "version_999999999999"
    });
    rs.on("data", function (data) {
      const workspace_id = parseInt(data.key.slice(8), 10);
      stats.total++;
      stats.has_version.push(workspace_id);
    });
    rs.on("close", function (err) {
      log.log("Verified %s workspaces.", stats.total);
      return cb(err, stats);
    });
    rs.on("error", function (err) {
      log.error("Error reading %s: %s", settings.server_db_dir, err);
      return cb(err, stats);
    });
  }];

  auto.db_check = ["workspace_stats", function (db_check_cb, response) {
    const stats = response.workspace_stats;
    async.eachSeries(stats.has_version, function (workspace_id, cb) {
      if (workspace_id % 100 === 0) {
        log.log("Verifying workspace %s", workspace_id);
      }
      const p = path.join(settings.bufs_dir, util.format("%s", workspace_id));
      fs.exists(p, function (exists) {
        if (!exists) {
          log.error("%s is in DB but missing dir on filesystem", p);
          stats.missing_dir.push(workspace_id);
          server.db.del(util.format("version_%s", workspace_id));
          return cb();
        }
        ldb.get_db(null, workspace_id, null, function (err, db) {
          if (err) {
            log.error("%s is in DB but leveldb is corrupt or doesn't exist! Error: %s", workspace_id, err);
            stats.bad_db.push(workspace_id);
            return cb();
          }
          // TODO: more verification of workspace DB at this point
          stats.ok.push(workspace_id);
          ldb.finish_db(db, workspace_id);
          return cb();
        });
      });
    }, function (err) {
      return db_check_cb(err, stats);
    });
  }];

  auto.fs_check = ["db_check", function (cb, response) {
    fs.readdir(settings.bufs_dir, function (err, workspaces) {
      const stats = response.db_check;
      _.each(workspaces, function (workspace) {
        const workspace_id = parseInt(workspace, 10);
        if (!_.includes(stats.has_version, workspace_id)) {
          log.error("%s on disk but has no version", workspace);
          stats.missing_version.push(workspace);
        }
      });
      return cb(err, stats);
    });
  }];

  auto.fs_cleanup = ["get_server_id", "fs_check", function (cb, response) {
    const stats = response.fs_check;
    _.each(stats.bad_db, function (bad_db) {
      const bad_key = util.format("version_%s", bad_db);
      log.error("Bad DB for %s. Deleting.", bad_db);
      server.db.del(bad_key, function (err) {
        if (err) {
          log.error("Error deleting version for bad key %s: %s", bad_key, err);
        } else {
          log.warn("Deleted version for bad key %s", bad_key);
        }
        actions.room.delete(bad_db);
      });
    });
    _.each(stats.missing_dir, function (missing) {
      const missing_key = util.format("version_%s", missing);
      log.error("Missing dir for %s. Deleting.", missing);
      server.db.del(missing_key, function (err) {
        if (err) {
          log.error("Error deleting version for missing dir %s: %s", missing_key, err);
        } else {
          log.warn("Deleted version for %s", missing_key);
        }
        actions.room.delete(missing);
      });
    });
    const total_errors = stats.bad_db.length + stats.missing_dir.length + stats.missing_version.length;
    log.log("%s errors out of %s workspaces. %s%%", total_errors, stats.total, (total_errors / stats.total) * 100);
    cb();
  }];

  async.auto(auto, function (err) {
    if (err) {
      throw new Error(err);
    }
  });
};
