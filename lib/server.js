var events = require("events");
var fs = require("fs");
var http = require("http");
var https = require("https");
var net = require("net");
var tls = require("tls");
var util = require("util");

var _ = require("lodash");
var async = require("async");
var express = require("express");
var mkdirp = require("mkdirp");

var settings = require("./settings");
var agent = require("./agent");
var command_server = require("./command_server");
var room = require("./room");
var log = require("./log");
var db = require("./db");
var mixpanel = require("./mixpanel");
var utils = require("./utils");


var ColabServer = function () {
  var self = this;
  self.conn_number = 0;
  self.agents = {};
  self.workspaces = {};
  self.server = net.createServer(self.on_conn.bind(self));
  self.ca = undefined;

  /*jslint stupid: true */
  if (settings.json_port_ssl || settings.socket_io_port_ssl) {
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

  if (settings.buf_storage.local) {
    mkdirp.sync(settings.buf_storage.local.dir);
  }

  if (settings.repo_dir) {
    mkdirp.sync(settings.repo_dir);
  }

  if (settings.json_port_ssl) {
    log.log("json ssl enabled on port", settings.json_port_ssl);
    self.server_ssl = tls.createServer({
      ca: self.ca,
      cert: self.cert,
      key: self.key
    }, self.on_conn.bind(self));
  }

  if (settings.socket_io_port_ssl) {
    log.log("socket.io ssl enabled on port", settings.socket_io_port_ssl);
    self.https_server = https.createServer({
      ca: self.ca,
      cert: self.cert,
      key: self.key
    });
  }
  if (settings.command_port) {
    log.log("command enabled on port", settings.command_port);
    command_server.listen(settings.command_port, self);
  }
  if (settings.metrics_port) {
    log.log("metrics enabled on port", settings.metrics_port);
    self.metrics_server = http.createServer(self.on_metrics.bind(self));
  }
};

ColabServer.prototype.listen = function () {
  var self = this;
  self.server.listen(settings.json_port);
  log.log("JSON protocol listening on port", settings.json_port);

  if (self.server_ssl) {
    self.server_ssl.listen(settings.json_port_ssl);
    log.log("JSON SSL protocol listening on port", settings.json_port_ssl);
  }

  self.io = require("socket.io").listen(settings.socket_io_port);
  self.io.configure(function () {
    self.io.enable("browser client minification");
    self.io.enable("browser client etag");
    self.io.enable("browser client gzip");
    self.io.enable("log");
    self.io.set("transports", settings.socket_io_transports);
    self.io.set("log level", 2);
  });
  self.io.sockets.on("connection", self.on_sio_conn.bind(self));
  log.log("Socket.io protocol listening on port", settings.socket_io_port);

  if (self.https_server) {
    self.io_ssl = require("socket.io").listen(self.https_server);
    self.https_server.listen(settings.socket_io_port_ssl);

    log.debug("configuring sio ssl");
    self.io_ssl.configure(function () {
      self.io_ssl.enable("browser client minification");
      self.io_ssl.enable("browser client etag");
      self.io_ssl.enable("browser client gzip");
      self.io_ssl.enable("log");
      self.io_ssl.set("transports", settings.socket_io_transports);
      self.io_ssl.set("log level", 2);
    });
    self.io_ssl.sockets.on("connection", self.on_sio_conn.bind(self));
    log.log("Socket.io SSL protocol listening on port", settings.socket_io_port_ssl);
  }
  if (self.metrics_server) {
    self.metrics_server.listen(81, "localhost", function (err, res) {
      if (err) {
        log.error(err);
      }
    });
  }
};

ColabServer.prototype.on_metrics = function (req, res) {
  var self = this,
    metrics = {},
    status = "ok",
    message = "harro",
    type,
    reply;

  reply = function () {
    res.writeHead(200);
    var response = util.format("status %s %s\n", status, message);
    _.each(metrics, function (v, k) {
      response += util.format("metric %s int %s\n", k, v);
    });
    res.end(response);
  };

  type = req.url.split("/")[1];
  if (type === undefined || (_.indexOf(["version", "platform", "client"], type) < 0)) {
    log.warn("Tried to fetch: " + type);
    status = "error";
    message = "404";
    return reply();
  }

  _.each(self.agents, function (agent) {
    var metric = (agent[type] && agent[type].toString()) || "undefined";
    metric = metric.replace(/\s/g, "");

    if (!metrics[metric]) {
      metrics[metric] = 1;
    } else {
      metrics[metric] += 1;
    }
  });

  return reply();
};

ColabServer.prototype.on_conn = function (conn) {
  var self = this,
    agent_conn,
    number;
  number = ++self.conn_number;
  conn.setNoDelay(true); // Disable Nagle algorithm
  if (settings.conn_keepalive) {
    conn.setKeepAlive(true, settings.conn_keepalive);
  }
  if (settings.conn_timeout) {
    conn.setTimeout(settings.conn_timeout, function () {
      conn.end();
      conn.destroy();
    });
  }
  agent_conn = new agent.AgentConnection(number, conn, self);
  self.agents[number] = agent_conn;
  log.debug("client", number, "connected from", conn.remoteAddress, ":", conn.remotePort);
  agent_conn.once("on_conn_end", self.on_conn_end.bind(self));
};

ColabServer.prototype.on_conn_end = function (agent_conn) {
  var self = this;

  mixpanel.people.increment(agent_conn.user_id, {
    "odometer": (Date.now() / 1000) - agent_conn.joined_at
  });

  if (agent_conn.parted === false) {
    try {
      agent_conn.room.part(agent_conn);
    } catch (e) {
      log.error("on_conn_end: Couldn't part client", agent_conn.id, ": ", e);
    }
  }
  delete self.agents[agent_conn.id];
  log.debug("client", agent_conn.id, "disconnected");
};

ColabServer.prototype.on_sio_conn = function (socket) {
  var self = this,
    agent_conn,
    number;
  number = ++self.conn_number;
  agent_conn = new agent.SIOAgentConnection(number, socket, self);
  self.agents[number] = agent_conn;
  log.debug("socket io client", number, "connected from", socket.handshake.address.address, ":", socket.handshake.address.port);
  agent_conn.once("on_conn_end", self.on_conn_end.bind(self));
};

ColabServer.prototype.save_state = function (cb) {
  var self = this;
  async.eachLimit(_.values(self.workspaces), 20, function (room, cb) {
    room.save_bufs(function () { cb(); });
  }, function (err) {
    log.log("finished saving all state");
    return cb(err);
  });
};

ColabServer.prototype.disconnect = function (cb) {
  var self = this;
  async.eachLimit(_.values(self.agents), 20, function (agent, cb) {
    agent.disconnect(null, cb);
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
  if (self.server_ssl) {
    log.log("Closing ssl server...");
    self.server_ssl.close();
  } else {
    log.debug("No socket io server to close");
  }
  log.log("Closing socket io server...");
  try {
    self.io.server.close();
  } catch (e2) {
    log.error("Couldn't close socket io server:", e2);
  }
  if (self.io_ssl) {
    log.log("Closing socket io ssl server...");
    self.io_ssl.server.close();
  } else {
    log.debug("No socket io ssl server to close");
  }
};

exports.run = function () {
  var self = this,
    server;

  log.set_log_level(settings.log_level);
  server = new ColabServer();

  function shut_down(sig) {
    log.log("caught signal: ", sig);
    server.stop_listening();
    async.series([
      server.disconnect.bind(server),
      server.save_state.bind(server)
    ], function (err) {
      if (err) {
        log.error(err);
        return process.exit(1);
      }
      return process.exit(0);
    });
  }

  db.connect(function (err, result) {
    if (err) {
      log.error("Error connecting to postgres:", err);
      process.exit(1);
    }

    process.on("SIGTERM", function () {shut_down("SIGTERM"); });
    process.on("SIGINT", function () {shut_down("SIGINT"); });

    process.on("SIGUSR1", function (sig) {
      log.log("caught signal SIGUSR1");
      server.save_state(function () {
        log.log("done");
      });
    });

    server.listen();
  });
};
