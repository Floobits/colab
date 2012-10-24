
var util = require('util');
var events = require('events');

var _ = require('underscore');

var ColabBuffer = require('./buffer');
var Room = require('./room');
var log = require('./log');

var SUPPORTED_VERSIONS = ['0.01'];


var BaseAgentConnection = function (id, conn, server) {
  var self = this;

  events.EventEmitter.call(self);

  self.id = id;
  self.conn = conn;
  self.bufs = null;
  self.room = null;
  // TODO: one day use a user object
  self.username = null;
  self.server = server;
  self.authenticated = false;
  self.auth_timeout = 10000;
  self.auth_timeout_id = null;
  self.dmp_listener = self.on_dmp.bind(self);

  self.allowed_actions = ["patch", "get_buf"];

  conn.on('end', function () {
    // do we need to remove the room listener?
    self.emit('on_conn_end', self);
  });
  self.on('dmp', function () {
    if (!self._room) {
      log.error("dmp emitted but agent isn't in a room!");
      return;
    }
    self._room.emit.call(arguments);
  });
  self.on('patch', self.on_patch.bind(self));
  self.on('get_buf', self.on_get_buf.bind(self));
};

util.inherits(BaseAgentConnection, events.EventEmitter);

BaseAgentConnection.prototype.auth = function (auth_data) {
  var self = this;
  if (_.has(auth_data, "username") &&
      _.has(auth_data, "secret") &&
      _.has(auth_data, "room") &&
      _.has(auth_data, "version")) {
    if (!_.contains(SUPPORTED_VERSIONS, auth_data.version)) {
      log.log("unsupported client version. disconnecting");
      self.disconnect();
      return;
    }

    /* TODO: actually auth against something */
    self.username = auth_data.username;
    self.secret = auth_data.secret;
    self.room = Room.add_agent(auth_data.room, self);
    self.bufs = self.room.bufs;
    self.authenticated = true;
    log.debug("client authenticated and joined room", self.room.name);
    clearTimeout(self.auth_timeout_id);
  } else {
    log.log("bad auth json. disconnecting client");
    self.disconnect();
    return;
  }
};

BaseAgentConnection.prototype.get_buf = function (path) {
  var self = this;
  var buf = self.bufs[path];
  if (buf === undefined) {
    log.debug("buf for path", path, "doesn't exist");
    log.debug("bufs:", self.bufs);
    // maybe room should do this
    buf = new ColabBuffer(self.room, path);
    self.bufs[path] = buf;
  }
  return buf;
}

BaseAgentConnection.prototype.on_patch = function (req) {
  var self = this;
  var buf = self.get_buf(req.path);
  buf.emit("dmp", self, req.patch, req.md5);
};

BaseAgentConnection.prototype.on_get_buf = function (req) {
  var self = this;
  var buf = self.get_buf(req.path);
  buf_json = buf.to_json();
  buf_json.name = "get_buf";
  self.write(json);
};


var AgentConnection = function (id, conn, server) {
  var self = this;

  BaseAgentConnection.call(self, id, conn, server);

  conn.on('connect', function () {
    log.debug("TCP connection");
    self.buf = "";
    self.auth_timeout_id = setTimeout(self.disconnect_unauthed_client.bind(self), self.auth_timeout);
  });
  conn.on('data', self.on_data.bind(self));
};

util.inherits(AgentConnection, BaseAgentConnection);

AgentConnection.prototype.disconnect = function () {
  var self = this;
  clearTimeout(self.auth_timeout_id);
  self.conn.destroy();
};

AgentConnection.prototype.disconnect_unauthed_client = function () {
  var self = this;
  if (self.authenticated === true) {
    log.debug("client authed before timeout, but this interval should have been cancelled");
  } else {
    log.log("client took too long to auth. disconnecting");
    self.disconnect();
  }
};

AgentConnection.prototype.on_data = function (d) {
  var self = this;
  var msg;
  var auth_data;

  log.debug("d: " + d);

  self.buf += d;
  if (self.buf.indexOf("\n") === -1) {
    log.debug("buf has no newline");
    return;
  }

  msg = self.buf.split("\n", 2);
  self.buf = msg[1];
  msg = msg[0];

  msg = JSON.parse(msg);
  if (self.authenticated) {
    // TODO: make sure req.name is in a whitelist of allowed names
    if (_.contains(self.allowed_actions, msg.name)) {
      self.emit(msg.name, msg);
    } else {
      log.error("action", msg.name, "not allowed");
      self.disconnect();
    }
  } else {
    self.auth(msg);
  }
};

AgentConnection.prototype.on_dmp = function (source_client, json) {
  var self = this;
  var str;
  json.name = "patch";
  if (source_client.id === self.id) {
    log.debug("not sending to source client", self.id);
  } else {
    self.write(json);
  }
};

AgentConnection.prototype.write = function (json) {
  var self = this;
  var str = JSON.stringify(json);
  log.debug("writing", str);
  self.conn.write(str + "\n");
};


var SIOAgentConnection = function (id, conn, server) {
  var self = this;

  BaseAgentConnection.call(self, id, conn, server);

  conn.on('auth', self.auth.bind(self));
  conn.on('patch', self.on_patch.bind(self));
  conn.on('get_buf', function (req) {
    var path = req.path;
    var buf = self.get_buf(req.path);
    var buf_json = buf.to_json();
    buf_json.name = "get_buf";
    conn.emit("get_buf", buf_json);
  });
};

util.inherits(SIOAgentConnection, BaseAgentConnection);

SIOAgentConnection.prototype.on_dmp = function (source_client, json) {
  var self = this;
  var str;
  if (source_client.id === self.id) {
    log.debug("not sending to source client", self.id);
  } else {
    self.conn.emit('patch', json);
  }
};



module.exports = {
  "AgentConnection": AgentConnection,
  "SIOAgentConnection": SIOAgentConnection
};
