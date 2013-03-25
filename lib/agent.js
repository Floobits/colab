var events = require('events');
var util = require('util');

var _ = require('underscore');
var async = require('async');

var Room = require('./room');
var db = require('./db');
var log = require('./log');
var utils = require('./utils');

var SUPPORTED_VERSIONS = ['0.01', '0.02'];
// Actions sent to everyone, including the client that sent the action
var BROADCAST_ACTIONS = ['create_buf', 'delete_buf', 'rename_buf'];

var BaseAgentConnection = function (id, conn, server) {
  var self = this;

  events.EventEmitter.call(self);

  self.id = id;
  self.conn = conn;
  self.client = "";
  self.platform = null;
  self.version = null;
  self.bufs = null;
  self.room = null;
  self.is_anon = false;
  self.username = null;
  self.user_id = null;
  self.server = server;
  self.authenticated = false;
  self.auth_timeout = 10000;
  self.auth_timeout_id = null;
  self.dmp_listener = self.on_dmp.bind(self);
  self.parted = false;

  self.allowed_actions = [];
};

util.inherits(BaseAgentConnection, events.EventEmitter);

BaseAgentConnection.prototype.disconnect = function (reason, cb) {
  var self = this;

  log.debug("disconnecting client", self.id, "ip", self.conn.remoteAddress);
  if (reason) {
    self.write("disconnect", {reason: reason});
  }

  if (self.auth_timeout_id) {
    clearTimeout(self.auth_timeout_id);
  }

  try {
    self.room.part(self);
    self.parted = true;
  } catch (e) {
    log.error("Couldn't part client", self.id, ": ", e);
  }

  return cb && cb();
};

BaseAgentConnection.prototype.auth = function (auth_data, cb) {
  var self = this;
  var auto;

  var OK = true;
  _.each(["username", "secret", "room_owner", "room", "version"], function (key){
    if (!_.has(auth_data, key)){
      OK = false;
    }
  });
  if (!OK) {
    log.log("bad auth json. disconnecting client");
    return self.disconnect();
  }
  if (!_.contains(SUPPORTED_VERSIONS, auth_data.version)) {
    log.log("unsupported client version. disconnecting");
    return self.disconnect();
  }

  self.username = auth_data.username;
  self.secret = auth_data.secret;
  self.client = auth_data.client || "";
  self.client = self.client.slice(0, 30);
  self.version = auth_data.version;
  self.platform = auth_data.platform;

  auto = {
    user: function (cb) {
      db.get_user(auth_data.username, function (err, result) {
        if (err) {
          return cb(null, {id: -1, username: "anon_" + self.id});
        }
        return cb(err, result);
      });
    },
    authed_user: ['user', function (cb, res) {
      if (res.user.id > 0) {
        db.auth_user(res.user.id, self.secret, cb);
      } else {
        cb(null, null);
      }
    }],
    room: ['authed_user', function (cb, res){
      if (res.user.id === -1) {
        self.is_anon = true;
      }
      self.username = res.user.username;
      self.user_id = res.user.id;
      log.debug("authenticated client", self.id, "user", self.username);
      self.authenticated = true;
      Room.add_agent(auth_data.room_owner, auth_data.room, self, res.user, cb);
    }]
  };
  return async.auto(auto, function (err, result) {
    var room_info;
    if (err || !result.room) {
      log.log("error adding agent", err);
      self.disconnect(err);
      return cb(err, {allowed_actions: []});
    }
    self.room = result.room;
    self.bufs = self.room.bufs;
    log.debug("client authenticated and joined room", self.room.name);
    clearTimeout(self.auth_timeout_id);
    room_info = self.room.to_json();
    // add_agent munges agent.allowed_actions :/
    room_info.perms = self.allowed_actions;

    self.write('room_info', room_info);

    _.each(self.room.msgs, function (msg) {
      self.write('msg', msg.to_json());
    });

    if (self.room.last_highlight) {
      self.write('highlight', self.room.last_highlight);
    }

    return cb(null, self);
  });
};

BaseAgentConnection.prototype.on_patch = function (req) {
  var self = this;
  var buf = self.room.get_buf(req.id);
  if (buf) {
    buf.patch(self, req.patch, req.md5_before, req.md5_after);
  } else {
    self.disconnect("buffer doesn't exist");
  }
};

BaseAgentConnection.prototype.on_get_buf = function (req) {
  var self = this,
      buf = self.room.get_buf(req.id),
      buf_json;
  if (!req.id) {
    self.write("error", {"msg": "update yo shit!"});
    return;
  }
  if (!buf.loaded) {
    buf.on("load", function () {
      buf_json = buf.to_json();
      self.write("get_buf", buf_json);
    });
  } else {
    buf_json = buf.to_json();
    self.write("get_buf", buf_json);
  }
};

BaseAgentConnection.prototype.on_create_buf = function (req) {
  var self = this;
  function cb(err, buf) {
    if (err) {
      self.write("error", {"msg": "create buf failed: " + err});
    } else {
      self.room.emit('dmp', self, "create_buf", buf.to_json());
    }
  }
  self.room.create_buf(req.path, req.buf, cb);
};

BaseAgentConnection.prototype.on_delete_buf = function (req) {
  var self = this;
  self.room.delete_buf(req.id, function (err, buf) {
    if (err) {
      self.write("error", {"msg": "delete buf failed!"});
    } else {
      self.room.emit('dmp', self, "delete_buf", {
        id: req.id,
        user_id: self.id,
        username: self.username,
        path: buf.path
      });
    }
  });
};

BaseAgentConnection.prototype.on_rename_buf = function (req) {
  var self = this;
  log.debug('renaming buf', req);
  self.room.rename_buf(req.id, req.path, function (err, old_path) {
    if (err) {
      log.error('error renaming buf:', err);
      self.write("error", {"msg": "rename buf failed!"});
    } else {
      self.room.emit('dmp', self, "rename_buf", {
        id: req.id,
        old_path: old_path,
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
    buf.highlight(self, req.ranges, req.ping);
  } else {
    self.write("error", {"msg": "buffer doesn't exist"});
  }
};

BaseAgentConnection.prototype.on_msg = function (req) {
  var self = this;
  self.room.on_msg(self, req.data);
};

BaseAgentConnection.prototype.on_kick = function (req) {
  var self = this;
  if (req === undefined || !_.isFinite(req.user_id)) {
    self.write("error", {"msg": "You tried to kick someone, but you didn't specify the user_id."});
    return;
  }
  var agent = self.room.agents[req.user_id];
  if (agent) {
    agent.disconnect("Kicked by " + self.username);
  } else {
    self.write("error", {"msg": "user id " + req.user_id + " doesn't exist"});
  }
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
  self.on('kick', self.on_kick.bind(self));
  self.on('msg', self.on_msg.bind(self));
  self.on('patch', self.on_patch.bind(self));
  self.on('rename_buf', self.on_rename_buf.bind(self));

  conn.on('data', self.on_data.bind(self));
  conn.on('error', self.disconnect.bind(self));
  conn.on('end', function () {
    self.emit('on_conn_end', self);
  });

  self.buf = "";
  self.auth_timeout_id = setTimeout(self.disconnect_unauthed_client.bind(self), self.auth_timeout);
};

util.inherits(AgentConnection, BaseAgentConnection);

AgentConnection.prototype.disconnect = function (reason, cb) {
  var self = this;

  BaseAgentConnection.prototype.disconnect.call(self, reason);

  try {
    self.conn.destroy();
  } catch (e) {
    log.error("Couldn't destroy connection:", self.id, ":", e);
  }

  return cb && cb();
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
  var newline_index;

  var handle_msg = function (msg) {
    try {
      msg = JSON.parse(msg);
    } catch (e) {
      log.error("couldn't parse json:", msg, "error:", e);
      return self.disconnect();
    }

    if (!self.authenticated) {
      return self.auth(msg, function () {});
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
  while (newline_index !== -1) {
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
      log.debug('allowed actions:', result.allowed_actions);
      _.each(result.allowed_actions, function (action) {
        // Socket.io has no on_data
        var method = self['on_'+action];
        if (!method) {
          log.error('Unknown allowed action:', action);
          return;
        }
        conn.on(action, method.bind(self));
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

SIOAgentConnection.prototype.disconnect = function (reason, cb) {
  var self = this;

  BaseAgentConnection.prototype.disconnect.call(self, reason);

  if (reason) {
    try {
      self.conn.disconnect();
    } catch (e) {
      log.error("Couldn't disconnect connection", self.id, ":", e);
    }
  }

  return cb && cb();
};

module.exports = {
  "AgentConnection": AgentConnection,
  "SIOAgentConnection": SIOAgentConnection
};
