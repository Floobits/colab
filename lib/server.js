/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var net = require("net");
var os = require("os");
var path = require("path");
var tls = require("tls");
var util = require("util");

var _ = require("lodash");
var async = require("async");
var fs = require("fs-extra");
var heapdump = require("heapdump");
var levelup = require("levelup");
var log = require("floorine");

var settings = require("./settings");
var actions = require("./actions");
var api_client = require("./api_client");
var ldb = require("./ldb");
var FloobitsProtocol = require("./protocol/floobits");
var MasterProtocol = require("./protocol/master");
var api_server = require("./api_server");
var room = require("./room");
var Room = room.Room;
var ProRoom = room.ProRoom;
var ROOM_STATES = room.STATES;
var ROOM_STATES_REVERSE = room.STATES_REVERSE;

var master_server = require("./master/master");

var INITIAL_RECONNECT_DELAY = 100;
var MAX_RECONNECT_DELAY = 10000;


var ColabServer = function () {
  var self = this,
    tls_options;

  self.slaves = [];
  self.conn_number = 0;
  self.agents = {};
  self.workspaces = {};
  self.handlers = {};
  self.ca = null;
  self.hostname = os.hostname();
  self.server = net.createServer(self.on_conn.bind(self));
  actions.conn.onEND(self.on_conn_end, this);
  actions.conn.onHANDLER(self.on_handler, this);
  actions.room.onADD_AGENT(self.on_add_agent, this);
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
    fs.writeFileSync(settings.ssh_wrapper_path,
      util.format("#!/bin/sh\nssh -i '%s' \"$@\"\n", settings.ssh_key_path));
    fs.chmodSync(settings.ssh_wrapper_path, "755");
  } else {
    log.warn("No SSH key info. Repo pulling may not work.");
  }
  /*eslint-enable no-sync */

  if (settings.json_port_ssl) {
    log.log("JSON SSL enabled on port", settings.json_port_ssl);
    self.server_ssl = tls.createServer(tls_options, self.on_conn.bind(self));
  }

  log.log("API enabled on port", settings.api_port);
  api_server.listen(settings.api_port, self);

  self.slave = new MasterProtocol(self.conn_number, !!settings.colab_master.ssl);
  self.master_reconnect_delay = INITIAL_RECONNECT_DELAY;
  self.master_reconnect_timeout = null;

  actions.broadcast.onSEND_TO_MASTER(function (type, data, cb) {
    if (!self.slave.handler) {
      return new Error("Not connected to master!");
    }
    self.slave.handler.broadcast(type, data, cb);
  });
};

ColabServer.prototype.listen = function (cb) {
  var self = this;
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
  var self = this,
    cleartext_stream,
    options;

  // TODO: total hack here
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  options = {
    port: settings.colab_master.port,
    host: settings.colab_master.ip
  };

  cb = cb || function () { return; };
  cb = _.once(cb);
  self.master_reconnect_timeout = null;

  log.log("Connecting to master (%s:%s)", settings.colab_master.ip, settings.colab_master.port);

  try {
    cleartext_stream = tls.connect(options, function () {
      log.log("Connection established to master (%s:%s)", settings.colab_master.ip, settings.colab_master.port);
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
  var self = this;

  if (self.master_reconnect_timeout) {
    return;
  }
  log.log("Reconnecting to master in %sms", self.master_reconnect_delay);
  self.master_reconnect_timeout = setTimeout(self.master_connect.bind(self), self.master_reconnect_delay);
  self.master_reconnect_delay = Math.min(self.master_reconnect_delay * 2, MAX_RECONNECT_DELAY);
};

ColabServer.prototype.on_conn = function (conn) {
  var self = this,
    number,
    is_ssl = false;

  log.debug("client %s connected from %s:%s", number, conn.remoteAddress, conn.remotePort);

  number = ++self.conn_number;
  conn.setNoDelay(true); // Disable Nagle algorithm
  conn.setEncoding("utf8");

  if (settings.conn_keepalive) {
    conn.setKeepAlive(true, settings.conn_keepalive);
  }

  if (conn.manager && self.server_ssl === conn.manager.server) {
    is_ssl = true;
  }
  if (conn.socket && self.server_ssl === conn.socket.server) {
    is_ssl = true;
  }
  self.agents[number] = new FloobitsProtocol(number);
  self.agents[number].init_conn(conn, is_ssl);
};

ColabServer.prototype.on_handler = function (id, handler) {
  var self = this;

  self.handlers[id] = handler;

  if (handler.is_slave) {
    self.slaves.push(handler);
  }
};

ColabServer.prototype.on_conn_end = function (agent_conn) {
  var self = this;

  delete self.agents[agent_conn.id];
  delete self.handlers[agent_conn.id];
  log.log("Client %s removed.", agent_conn.toString());
};

ColabServer.prototype.on_add_agent = function (owner, name, agent, user, cb) {
  var self = this,
    workspace;

  function finish(err) {
    if (err) {
      log.error(err);
      return cb(err);
    }
    workspace.add_agent(agent, user, cb);
  }

  log.log("Adding agent %s for workspace %s owned by %s", agent.toString(), name, owner);

  api_client.workspace_get(owner, name, function (err, result) {
    var RoomClass = Room, db_room;
    if (err) {
      return finish(err);
    }

    log.log("Found workspace", result.id);
    log.debug("workspace_get response: %s", JSON.stringify(result));
    db_room = result;

    if (db_room === undefined) {
      log.error("Workspace id not found for", owner, name);
      return finish("Workspace not found");
    }

    workspace = self.workspaces[db_room.id];
    if (workspace) {
      if (workspace.state === ROOM_STATES.LOADING) {
        return workspace.once("load", finish);
      }
      if (workspace.state === ROOM_STATES.LOADED) {
        // In case it was updated
        workspace.max_size = db_room.max_size;
        return finish();
      }
      return finish(util.format("This workspace is in state %s. No new connections allowed. Please try again shortly.",
                                ROOM_STATES_REVERSE[workspace.state]));
    }
    if (db_room.pro) {
      RoomClass = ProRoom;
    }
    workspace = new RoomClass(db_room.id,
      db_room.name,
      owner, {
        cur_fid: db_room.cur_fid,
        max_size: db_room.max_size,
        secret: db_room.secret,
        repo_info: db_room.repo_info,
        created_at: db_room.created_at,
        updated_at: db_room.updated_at,
      }, self);

    self.workspaces[db_room.id] = workspace;
    workspace.once("load", finish);
    workspace.load(agent);
  });
};

ColabServer.prototype.save_state = function (save_cb) {
  var self = this;
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
  var self = this;
  _.each(self.agents, function (a) {
    // Only send wallops to normal clients
    if (!a.handler || a.handler.is_slave) {
      return;
    }
    a.error(null, msg, true);
  });
};

ColabServer.prototype.disconnect = function (disconnect_cb) {
  var self = this;
  async.eachLimit(_.values(self.agents), 20, function (agent, cb) {
    agent.destroy();
    cb();
  }, function (err) {
    log.log("Everyone is disconnected");
    return disconnect_cb(err);
  });
};

ColabServer.prototype.stop_listening = function () {
  var self = this;
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
  var auto = {},
    master,
    server;

  log.set_log_level(settings.log_level);
  if (_.isUndefined(heapdump)) {
    log.error("No heapdump ability.");
  }
  server = new ColabServer();

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
    var options = {
      createIfMissing: true
    };
    log.log("Opening %s...", settings.server_db_dir);
    return levelup(settings.server_db_dir, options, cb);
  };

  auto.get_server_id = ["leveldb_open", function (cb, response) {
    log.log("Opened %s.", settings.server_db_dir);
    response.leveldb_open.get("server_id", function (db_open_err, result) {
      var server_id;
      if (db_open_err) {
        if (db_open_err.type === "NotFoundError") {
          server_id = util.format("%s_%s", os.hostname(), ("00000" + (Math.random() * 100000)).slice(-6));
          return response.leveldb_open.put("server_id", server_id, function (err) {
            return cb(err, server_id);
          });
        }
        return cb(db_open_err);
      }
      return cb(null, result);
    });
  }];

  auto.listen = ["get_server_id", server.listen.bind(server)];

  if (settings.colab_master) {
    auto.master_connect = ["listen", server.master_connect.bind(server)];
  }

  auto.workspace_stats = ["get_server_id", function (cb, response) {
    var db = response.leveldb_open,
      stats,
      rs;

    stats = {
      bad_db: [],
      has_version: [],
      missing_dir: [],
      missing_version: [],
      ok: [],
      total: 0
    };

    cb = _.once(cb);

    server.db = db;
    server.id = response.get_server_id;
    log.log("Server ID is %s", server.id);

    rs = db.createReadStream({
      start: "version_",
      end: "version_999999999999"
    });
    rs.on("data", function (data) {
      var workspace_id = parseInt(data.key.slice(8), 10);
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
    var stats = response.workspace_stats;

    async.eachSeries(stats.has_version, function (workspace_id, cb) {
      var p = path.join(settings.bufs_dir, util.format("%s", workspace_id));

      if (workspace_id % 100 === 0) {
        log.log("Verifying workspace %s", workspace_id);
      }

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
    var stats = response.db_check;
    fs.readdir(settings.bufs_dir, function (err, workspaces) {
      _.each(workspaces, function (workspace) {
        var workspace_id = parseInt(workspace, 10);
        if (!_.contains(stats.has_version, workspace_id)) {
          log.error("%s on disk but has no version", workspace);
          stats.missing_version.push(workspace);
        }
      });
      return cb(err, stats);
    });
  }];

  auto.fs_cleanup = ["get_server_id", "fs_check", function (cb, response) {
    var stats = response.fs_check,
      total_errors = stats.bad_db.length + stats.missing_dir.length + stats.missing_version.length;
    _.each(stats.bad_db, function (bad_db) {
      var bad_key = util.format("version_%s", bad_db);
      log.error("Bad DB for %s. Deleting.", bad_db);
      server.db.del(bad_key, function (err) {
        if (err) {
          log.error("Error deleting version for bad key %s: %s", bad_key, err);
        } else {
          log.warn("Deleted version for bad key %s", bad_key);
        }
      });
    });
    _.each(stats.missing_dir, function (missing) {
      var missing_key = util.format("version_%s", missing);
      log.error("Missing dir for %s. Deleting.", missing);
      server.db.del(missing_key, function (err) {
        if (err) {
          log.error("Error deleting version for missing dir %s: %s", missing_key, err);
        } else {
          log.warn("Deleted version for %s", missing_key);
        }
      });
    });
    log.log("%s errors out of %s workspaces. %s%%", total_errors, stats.total, (total_errors / stats.total) * 100);
    cb();
  }];

  async.auto(auto, function (err) {
    if (err) {
      throw new Error(err);
    }
  });
};
