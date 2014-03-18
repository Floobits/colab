var events = require("events");
var http = require("http");
var https = require("https");
var net = require("net");
var os = require("os");
var path = require("path");
var tls = require("tls");
var util = require("util");

var _ = require("lodash");
var async = require("async");
var fs = require("fs-extra");
var levelup = require("levelup");
var log = require("floorine");

var settings = require("./settings");
var ldb = require("./ldb");
var agent = require("./agent");
var cache = require("./cache");
var api_server = require("./api_server");
var room = require("./room");
var db = require("./db");
var utils = require("./utils");


var ColabServer = function () {
  var self = this,
    tls_options;

  self.conn_number = 0;
  self.agents = {};
  self.workspaces = {};
  self.server = net.createServer(self.on_conn.bind(self));
  self.ca = null;
  self.hostname = os.hostname();

  /*jslint stupid: true */
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
      ciphers: "ECDHE-RSA-AES256-SHA384:AES256-SHA256:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM",
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
  /*jslint stupid: false */

  if (settings.json_port_ssl) {
    log.log("JSON SSL enabled on port", settings.json_port_ssl);
    self.server_ssl = tls.createServer(tls_options, self.on_conn.bind(self));
  }

  log.log("API enabled on port", settings.api_port);
  api_server.listen(settings.api_port, self);
};

ColabServer.prototype.listen = function () {
  var self = this;
  self.server.listen(settings.json_port);
  log.log("JSON protocol listening on port", settings.json_port);

  if (self.server_ssl) {
    self.server_ssl.listen(settings.json_port_ssl);
    log.log("JSON SSL protocol listening on port", settings.json_port_ssl);
  } else {
    self.server_ssl = {server: null};
  }
};

ColabServer.prototype.on_conn = function (conn) {
  var self = this,
    agent_conn,
    number;
  number = ++self.conn_number;
  conn.setNoDelay(true); // Disable Nagle algorithm
  conn.setEncoding("utf8");
  if (settings.conn_keepalive) {
    conn.setKeepAlive(true, settings.conn_keepalive);
  }
  agent_conn = new agent.AgentConnection(number, conn, self);
  self.agents[number] = agent_conn;
  log.debug("client %s connected from %s:%s", number, conn.remoteAddress, conn.remotePort);
  agent_conn.once("on_conn_end", self.on_conn_end.bind(self));
};

ColabServer.prototype.on_conn_end = function (agent_conn) {
  var self = this;

  agent_conn.destroy();

  delete self.agents[agent_conn.id];
  log.log("Client %s removed.", agent_conn.toString());
};

ColabServer.prototype.update_active_workspaces = function () {
  var self = this,
    key = "active_workspaces",
    active_workspaces = _.filter(self.workspaces, function (w) {
      return w.state === room.STATES.LOADED;
    }).map(function (w) {
      return {
        id: w.id,
        server: self.hostname
      };
    });

  cache.cas_set(key, function (result) {
    result = _.filter(result, function (w) {
      return w.server !== self.server.hostname;
    });
    active_workspaces = _.union(result, active_workspaces);
    active_workspaces = _.uniq(active_workspaces, function (w) {
      return JSON.stringify(w);
    });
    return active_workspaces;
  });
};

ColabServer.prototype.save_state = function (cb) {
  var self = this;
  async.eachLimit(_.values(self.workspaces), 20, function (room, cb) {
    room.save_bufs(function () {
      setImmediate(cb);
    });
  }, function (err) {
    log.log("finished saving all state");
    return cb(err);
  });
};

ColabServer.prototype.disconnect = function (cb) {
  var self = this;
  async.eachLimit(_.values(self.agents), 20, function (agent, cb) {
    setImmediate(function () {
      agent.disconnect(null, cb);
    });
  }, function (err) {
    log.log("Everyone is disconnected");
    return cb(err);
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
    server;

  log.set_log_level(settings.log_level);
  server = new ColabServer();

  function shut_down(sig) {
    log.log("Caught signal ", sig);
    server.stop_listening();
    async.series([
      server.disconnect.bind(server),
      server.save_state.bind(server)
    ], function (err) {
      db.end();
      if (err) {
        log.error(err);
        return process.exit(1);
      }
      return process.exit(0);
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

  auto.cache_connect = function (cb) {
    if (settings.cache_servers) {
      return cache.connect(cb);
    }
    log.warn("No cache settings. Not connecting to cache.");
    return cb();
  };

  auto.leveldb_open = function (cb) {
    var options = {
      createIfMissing: true
    };
    log.log("Opening %s...", settings.server_db_dir);
    return levelup(settings.server_db_dir, options, cb);
  };

  auto.get_server_id = ["leveldb_open", function (cb, response) {
    log.log("Opened %s.", settings.server_db_dir);
    response.leveldb_open.get("server_id", function (err, result) {
      var server_id;
      if (err) {
        if (err.type === "NotFoundError") {
          server_id = util.format("%s_%s", os.hostname(), ("00000" + (Math.random() * 100000)).slice(-6));
          return response.leveldb_open.put("server_id", server_id, function (err) {
            return cb(err, server_id);
          });
        }
        return cb(err);
      }
      return cb(null, result);
    });
  }];

  auto.listen = ["get_server_id", function (cb) {
    server.listen();
    return cb();
  }];

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

  auto.db_check = ["workspace_stats", function (cb, response) {
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
          stats.ok.push(workspace_id);
          ldb.finish_db(db, workspace_id);
          return cb();
        });
      });
    }, function (err) {
      return cb(err, stats);
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

  auto.fs_cleanup = ["cache_connect", "get_server_id", "fs_check", function (cb, response) {
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

  async.auto(auto, function (err, result) {
    if (err) {
      log.error("Error starting up:", err, result);
      process.exit(1);
    }
  });
};
