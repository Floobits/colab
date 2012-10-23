
var util = require('util');
var events = require('events');

var _ = require('underscore');

var ColabBuffer = require('./buffer');
var Room = require('./room');
var log = require('./log');

var SUPPORTED_VERSIONS = ['0.01'];


var AgentConnection = function(id, conn, server) {
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

  conn.on('end', function() {
    // do we need to remove the room listener?
    self.emit('on_conn_end', self);
  });
  conn.on('connect', function () {
    self.buf = "";
    self.auth_timeout_id = setTimeout(self.disconnect_unauthed_client.bind(self), self.auth_timeout);
  });
  conn.on('data', self.on_data.bind(self));

  self.on('request', self.on_request.bind(self));
  self.on('dmp', function() {
    if (!self._room) {
      log.error("dmp emitted but agent isn't in a room!");
      return;
    }
    self._room.emit.call(arguments);
  });
};

util.inherits(AgentConnection, events.EventEmitter);

AgentConnection.prototype.disconnect = function() {
  var self = this;
  clearTimeout(self.auth_timeout_id);
  self.conn.destroy();
};

AgentConnection.prototype.disconnect_unauthed_client = function() {
  var self = this;
  if (self.authenticated === true) {
    log.debug("client authed before timeout, but this interval should have been cancelled");
  } else {
    log.log("client took too long to auth. disconnecting");
    self.disconnect();
  }
};

AgentConnection.prototype.on_data = function(d) {
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

  if (self.authenticated) {
    self.emit('request', msg);
  } else {
    auth_data = JSON.parse(msg);
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
  }
};

AgentConnection.prototype.on_request = function(raw) {
  var self = this;
  var buf;
  var req = JSON.parse(raw);
  var str;

  if (!req.path) {
    log.log("bad client: no path. goodbye");
    return self.disconnect();
  }

  if (req.action === "patch") {
    buf = self.bufs[req.path];
    if (!buf) {
      // maybe room should do this
      buf = new ColabBuffer(self.room, req.path);
      self.bufs[buf.path] = buf;
    }
    buf.emit("dmp", req.patch, req.md5);
  } else if (req.action === "get_buf") {
    buf = self.bufs[req.path];
    buf_json = buf.to_json();
    buf_json.action = "get_buf";
    str = JSON.stringify(buf_json);
    self.conn.write(str + "\n");
  }
};

AgentConnection.prototype.on_dmp = function(json) {
  var self = this;
  var str;
  json.action = "patch";
  str = JSON.stringify(json) + "\n";
  log.debug("writing", str);
  self.conn.write(str);
};

module.exports = AgentConnection;
