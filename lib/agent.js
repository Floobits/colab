var events = require('events');
var util = require('util');

var _ = require('underscore');

var Room = require('./room');
var db = require('./db');
var log = require('./log');

var SUPPORTED_VERSIONS = ['0.01'];
// Actions sent to everyone, including the client that sent the action
var BROADCAST_ACTIONS = ['create_buf', 'delete_buf', 'rename_buf'];

var BaseAgentConnection = function (id, conn, server) {
  var self = this;

  events.EventEmitter.call(self);

  self.id = id;
  self.conn = conn;
  self.bufs = null;
  self.room = null;
  self.is_anon = false;
  self.username = null;
  self.server = server;
  self.authenticated = false;
  self.auth_timeout = 10000;
  self.auth_timeout_id = null;
  self.dmp_listener = self.on_dmp.bind(self);

  self.allowed_actions = ["patch", "get_buf", "create_buf", "highlight", "msg", "delete_buf", "rename_buf"];
};

util.inherits(BaseAgentConnection, events.EventEmitter);

BaseAgentConnection.prototype.disconnect = function (reason) {
  var self = this;
  if (reason) {
    self.write("disconnect", {reason: reason});
  }
  if (self.auth_timeout_id) {
    clearTimeout(self.auth_timeout_id);
  }
  log.debug("disconnecting client", self.id, "ip", self.conn.remoteAddress);
  try {
    self.conn.destroy();
  } catch (e) {
    log.error("Couldn't destroy connection:", e);
  }
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
      if (self.username === "") {
        self.is_anon = true;
        self.username = "anon_" + self.id;
      } else if (err) {
        log.log("error authing or bad user/pass. disconnecting");
        self.disconnect(err);
        return;
      }

      log.debug("authenticated client", self.id, "user", self.username);
      self.authenticated = true;
      Room.add_agent(auth_data.room_owner, auth_data.room, self, function (err, result) {
        var room_info;
        if (err || !result) {
          log.log("error adding agent", err);
          self.disconnect();
          return;
        }
        self.room = result;
        self.bufs = self.room.bufs;
        log.debug("client authenticated and joined room", self.room.name);
        clearTimeout(self.auth_timeout_id);
        room_info = self.room.to_json();
        // add_agent munges agent.allowed_actions :/
        room_info.perms = self.allowed_actions;
        self.write('room_info', room_info);
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
  var md5_after = req.md5_after || req.md5;
  if (buf) {
    buf.patch(self, req.patch, req.md5_before, md5_after);
    self.room.save(); // TODO: this writes to the DB too much
  } else {
    self.disconnect("buffer doesn't exist");
  }
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
    self.room.emit('dmp', self, "create_buf", buf.to_json());
  } else {
    self.write("error", {"msg": "create buf failed!"});
  }
};

BaseAgentConnection.prototype.on_delete_buf = function (req) {
  var self = this;
  self.room.delete_buf(req.buf_id, function (err, result) {
    if (err) {
      self.write("error", {"msg": "delete buf failed!"});
    } else {
      self.room.emit('dmp', self, "delete_buf", {
        buf_id: req.buf_id,
        user_id: self.id,
        username: self.username
      });
    }
  });
};

BaseAgentConnection.prototype.on_rename_buf = function (req) {
  var self = this;
  self.room.rename_buf(req.buf_id, req.path, function (err, result) {
    if (err) {
      self.write("error", {"msg": "rename buf failed!"});
    } else {
      self.room.emit('dmp', self, "rename_buf", {
        buf_id: req.buf_id,
        path: req.path,
        user_id: self.id,
        username: self.username
      });
    }
  });
};

BaseAgentConnection.prototype.on_highlight = function (req) {
  var self = this;
  log.debug("agent.js: agent", self.id, "user", self.username, "highlighted", req.ranges);
  var buf = self.room.get_buf(req.id);
  if (buf) {
    // TODO: validate ranges
    buf.highlight(self, req.ranges);
  } else {
    self.write("error", {"msg": "buffer doesn't exist"});
  }
};

BaseAgentConnection.prototype.on_msg = function (req) {
  var self = this;
  self.room.emit("dmp", self, "msg", {
    user_id: self.id,
    username: self.username,
    data: req.data
  });
};

BaseAgentConnection.prototype.on_dmp = function (source_client, action, json) {
  var self = this;
  if (source_client.id === self.id && _.contains(BROADCAST_ACTIONS, action) === false) {
    log.debug("action", action, "not sending to source client", self.id);
  } else {
    self.write(action, json);
  }
};


var AgentConnection = function (id, conn, server) {
  var self = this;

  BaseAgentConnection.call(self, id, conn, server);

  self.on('create_buf', self.on_create_buf.bind(self));
  self.on('delete_buf', self.on_delete_buf.bind(self));
  self.on('get_buf', self.on_get_buf.bind(self));
  self.on('highlight', self.on_highlight.bind(self));
  self.on('msg', self.on_msg.bind(self));
  self.on('patch', self.on_patch.bind(self));
  self.on('rename_buf', self.on_rename_buf.bind(self));

  conn.on('connect', function () {
    log.debug("TCP connection from", conn.remoteAddress);
    self.buf = "";
    self.auth_timeout_id = setTimeout(self.disconnect_unauthed_client.bind(self), self.auth_timeout);
  });
  conn.on('data', self.on_data.bind(self));
  conn.on('error', self.disconnect.bind(self));
  conn.on('end', function () {
    self.emit('on_conn_end', self);
  });
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
  var newline_index;

  var handle_msg = function(msg){
    try {
      msg = JSON.parse(msg);
    } catch (e) {
      log.error("couldn't parse json:", e);
      return self.disconnect();
    }

    if (!self.authenticated){
      return self.auth(msg);
    }

    if (_.contains(self.allowed_actions, msg.name)) {
      log.debug("emitting", msg.name, "event");
      return self.emit(msg.name, msg);
    }

    log.error("action", msg.name, "not allowed");
    return self.disconnect();
  };

  log.debug("d: |" + d + "|");

  self.buf += d;

  newline_index = self.buf.indexOf('\n');
  while (newline_index !== -1){
    msg = self.buf.slice(0, newline_index);
    self.buf = self.buf.slice(newline_index+1);
    handle_msg(msg);
    newline_index = self.buf.indexOf('\n');
  }
};

AgentConnection.prototype.write = function (name, json) {
  var self = this, str;
  json.name = name;
  str = JSON.stringify(json);
  log.debug("writing to conn", self.id, ":", str);
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
        } else if (action === "highlight") {
          conn.on('highlight', self.on_highlight.bind(self));
        } else if (action === "msg") {
          conn.on('msg', self.on_msg.bind(self));
        } else if (action === "delete_buf") {
          conn.on('delete_buf', self.on_delete_buf.bind(self));
        } else if (action === "rename_buf") {
          conn.on('rename_buf', self.on_rename_buf.bind(self));
        }
      });
    });
  });
  conn.on('disconnect', function () {
    self.emit('on_conn_end', self);
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
