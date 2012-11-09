var events = require('events');
var util = require('util');

var _ = require('underscore');

var Room = require('./room');
var db = require('./db');
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
  self.is_anon = false;
  self.username = null;
  self.server = server;
  self.authenticated = false;
  self.auth_timeout = 10000;
  self.auth_timeout_id = null;
  self.dmp_listener = self.on_dmp.bind(self);

  self.allowed_actions = ["patch", "get_buf", "create_buf"];

  conn.on('end', function () {
    // server removes the listener
    self.emit('on_conn_end', self);
  });
};

util.inherits(BaseAgentConnection, events.EventEmitter);

BaseAgentConnection.prototype.disconnect = function () {
  var self = this;
  if (self.auth_timeout_id) {
    clearTimeout(self.auth_timeout_id);
  }
  log.debug("disconnecting client", self.id, "ip", self.conn.remoteAddress);
  self.conn.destroy();
};

BaseAgentConnection.prototype.auth = function (auth_data, cb) {
  var self = this;
  if (_.has(auth_data, "username") &&
      _.has(auth_data, "secret") &&
      _.has(auth_data, "room_owner") &&
      _.has(auth_data, "room") &&
      _.has(auth_data, "version")) {
    if (!_.contains(SUPPORTED_VERSIONS, auth_data.version)) {
      log.log("unsupported client version. disconnecting");
      self.disconnect();
      return;
    }

    self.username = auth_data.username;
    self.secret = auth_data.secret;
    db.auth_user(self.username, self.secret, function (err, result) {
      if (err) {
        if (result.rowCount !== 0) {
          // There was an error other than user not found
          log.log("error authing or bad user/pass. disconnecting");
          self.disconnect();
          return;
        } else {
          self.is_anon = true;
        }
      }
      log.debug("authenticated client", self.id, "user", self.username);
      self.authenticated = true;
      Room.add_agent(auth_data.room_owner, auth_data.room, self, function (err, result) {
        if (err || !result) {
          log.log("error adding agent", err);
          self.disconnect();
          return;
        }
        self.room = result;
        self.bufs = self.room.bufs;
        log.debug("client authenticated and joined room", self.room.name);
        clearTimeout(self.auth_timeout_id);
        self.send_room_info(self.room.to_json());
        if (cb) {
          cb(undefined, self);
        }
      });
    });
  } else {
    log.log("bad auth json. disconnecting client");
    self.disconnect();
    return;
  }
};

BaseAgentConnection.prototype.on_patch = function (req) {
  var self = this;
  var buf = self.room.get_buf(req.id);
  buf.patch(self, req.patch, req.md5);
};

BaseAgentConnection.prototype.on_get_buf = function (req) {
  var self = this;
  var buf = self.room.get_buf(req.id);
  if (!req.id){
    self.write("error", {"update": "yo shit!"});
    return;
  }
  var buf_json = buf.to_json();
  self.write("get_buf", buf_json);
};

BaseAgentConnection.prototype.on_create_buf = function (req) {
  var self = this;
  var buf = self.room.create_buf(req.path);
  if (buf) {
    self.write("create_buf", buf.to_json());
  } else {
    self.write("error", {"msg": "create buf failed!"});
  }
};

BaseAgentConnection.prototype.send_room_info = function (ri) {
  var self = this;
  self.write('room_info', ri);
};

BaseAgentConnection.prototype.on_dmp = function (source_client, json) {
  var self = this;
  if (source_client.id === self.id) {
    log.debug("not sending to source client", self.id);
  } else {
    self.write('patch', json);
  }
};

var AgentConnection = function (id, conn, server) {
  var self = this;

  BaseAgentConnection.call(self, id, conn, server);

  self.on('get_buf', self.on_get_buf.bind(self));
  self.on('patch', self.on_patch.bind(self));

  conn.on('connect', function () {
    log.debug("TCP connection");
    self.buf = "";
    self.auth_timeout_id = setTimeout(self.disconnect_unauthed_client.bind(self), self.auth_timeout);
  });
  conn.on('data', self.on_data.bind(self));
};

util.inherits(AgentConnection, BaseAgentConnection);

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

  try {
    msg = JSON.parse(msg);
  } catch (e) {
    log.error("couldn't parse json:", e);
    self.disconnect();
  }
  if (self.authenticated) {
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

AgentConnection.prototype.write = function (name, json) {
  var self = this, str;
  json.name = name;
  str = JSON.stringify(json);
  log.debug("writing", str);
  try {
    self.conn.write(str + "\n");
  } catch (e) {
    log.error("error writing to client:", e, "disconnecting");
    self.disconnect();
  }
};

var SIOAgentConnection = function (id, conn, server) {
  var self = this;

  BaseAgentConnection.call(self, id, conn, server);
  conn.on('auth', function (auth_data) {
    self.auth(auth_data, function (err, result) {
      _.each(result.allowed_actions, function (action) {
        // Socket.io has no on_data
        if (action === "patch") {
          conn.on('patch', self.on_patch.bind(self));
        } else if (action === "get_buf") {
          conn.on('get_buf', self.on_get_buf.bind(self));
        } else if (action === "create_buf") {
          conn.on('create_buf', self.on_create_buf.bind(self));
        }
      });
    });
  });
};

util.inherits(SIOAgentConnection, BaseAgentConnection);

SIOAgentConnection.prototype.write = function (name, json) {
  var self = this;
  self.conn.emit(name, json);
};

module.exports = {
  "AgentConnection": AgentConnection,
  "SIOAgentConnection": SIOAgentConnection
};
