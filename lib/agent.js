var events = require("events");
var util = require("util");

var _ = require("underscore");
var async = require("async");

var Repo = require("./repo");
var Room = require("./room");
var db = require("./db");
var log = require("./log");
var MSG = require("./msg");
var perms = require("./perms");
var utils = require("./utils");

var SUPPORTED_VERSIONS = [0.01, 0.02, 0.03];
// Actions sent to everyone, including the client that sent the action
var BROADCAST_ACTIONS = ["create_buf", "delete_buf", "rename_buf", "create_term", "delete_term", "user_info"];

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
  self.disconnected = false;
  self.last_highlight = {};

  self.perms = [];
};

util.inherits(BaseAgentConnection, events.EventEmitter);

BaseAgentConnection.prototype.to_json = function () {
  var self = this;

  return {
    client: self.client,
    user_id: self.id,
    is_anon: self.is_anon,
    perms: self.perms,
    platform: self.platform,
    username: self.username,
    version: self.version
  };
};

BaseAgentConnection.prototype.toString = function () {
  var self = this;
  return util.format("user %s conn_id %s client %s", self.username, self.id, self.client);
};

BaseAgentConnection.prototype.error = function (msg, flash) {
  var self = this;
  flash = !!flash;
  self.write("error", {"msg": msg, "flash": flash});
};

BaseAgentConnection.prototype.disconnect = function (reason, cb) {
  var self = this;

  if (self.disconnected) {
    return;
  }
  self.disconnected = true;

  log.debug("disconnecting client", self.id, "ip", self.conn.remoteAddress);
  if (reason) {
    self.write("disconnect", {reason: reason});
  }

  if (self.auth_timeout_id) {
    clearTimeout(self.auth_timeout_id);
    self.auth_timeout_id = null;
  }

  try {
    // TODO: this totally doesn't work for socket.io clients
    self.room.part(self);
    self.parted = true;
  } catch (e) {
    log.error("Couldn't part client", self.id, ": ", e);
  }

  return cb && cb();
};

BaseAgentConnection.prototype.allow = function (actions) {
};

BaseAgentConnection.prototype.is_ssl = function () {
  var self = this;
  if (self.conn && self.conn.manager && _.contains([self.server.server_ssl, self.server.io_ssl.server], self.conn.manager.server)) {
    return true;
  }
  return false;
};


BaseAgentConnection.prototype.auth = function (auth_data, cb) {
  var self = this,
    auto,
    OK = true;
  _.each(["username", "secret", "room_owner", "room", "version"], function (key) {
    if (!_.has(auth_data, key)) {
      OK = false;
    }
  });
  if (!OK) {
    log.log("bad auth json. disconnecting client");
    return self.disconnect();
  }
  auth_data.version = Number(auth_data.version);
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

  if (!auth_data.supported_encodings || _.isEmpty(auth_data.supported_encodings)) {
    log.log("Client didn't send supported encodings. Defaulting to utf8-only.");
    auth_data.supported_encodings = ["utf8"];
  }
  // TODO: validate this
  self.supported_encodings = auth_data.supported_encodings;

  auto = {
    user: function (cb) {
      if (auth_data.username === "") {
        return cb(null, {id: -1, username: "anon_" + self.id});
      }
      db.get_user(auth_data.username, function (err, result) {
        if (err) {
          return cb("Invalid username or secret", result);
        }
        return cb(err, result);
      });
    },
    authed_user: ["user", function (cb, res) {
      if (res.user.id > 0) {
        db.auth_user(res.user.id, self.secret, cb);
      } else {
        cb(null, null);
      }
    }],
    room: ["authed_user", function (cb, res) {
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
      return cb(err, {perms: []});
    }
    self.room = result.room;
    self.bufs = self.room.bufs;
    log.debug("client authenticated and joined room", self.room.name);
    clearTimeout(self.auth_timeout_id);
    room_info = self.room.to_json();
    // add_agent munges agent.perms :/
    room_info.perms = self.perms;
    room_info.user_id = self.id;

    self.write("room_info", room_info);

    _.each(self.room.msgs, function (msg) {
      self.write("msg", msg.to_json());
    });

    if (self.room.last_highlight) {
      self.write("highlight", self.room.last_highlight);
    }

    return cb(null, self);
  });
};

BaseAgentConnection.prototype.on_patch = function (req) {
  var self = this,
    buf = self.room.get_buf(req.id);
  // TODO: this could falsely trigger if someone's typing in a buffer that another user deletes
  if (!buf) {
    self.disconnect("Your client tried to patch a buffer that doesn't exist");
    return;
  }
  buf.patch(self, req.patch, req.md5_before, req.md5_after);
};

BaseAgentConnection.prototype.on_get_buf = function (req) {
  var self = this,
    buf = self.room.get_buf(req.id);
  if (!buf) {
    self.disconnect("Your client tried to fetch a buffer that doesn't exist");
    return;
  }
  if (!buf.loaded) {
    buf.once("load", function () {
      buf.send_get_buf(self, 0);
    });
  } else {
    buf.send_get_buf(self, 0);
  }
};

BaseAgentConnection.prototype.on_create_buf = function (req) {
  var self = this;
  function cb(err, buf) {
    if (err) {
      self.error("create buf failed: " + err);
    }
  }
  if (!req.encoding) {
    log.warn(util.format("old client %s didn't specify encoding. defaulting to utf8"), self.toString());
    req.encoding = "utf8";
  }
  self.room.create_buf(req.path, req.buf, req.encoding, self, cb);
};

BaseAgentConnection.prototype.on_delete_buf = function (req) {
  var self = this;
  self.room.delete_buf(req.id, self, function (err, buf) {
    if (err) {
      self.error(util.format("Error deleting buffer %s: %s", req.id, err));
    }
  });
};

BaseAgentConnection.prototype.on_rename_buf = function (req) {
  var self = this;
  log.debug("renaming buf", req);
  self.room.rename_buf(req.id, req.path, self, function (err, old_path) {
    if (err) {
      log.error("error renaming buf:", err);
      self.error(util.format("Error renaming buffer %s to %s: %s", req.id, req.path, err), true);
    }
  });
};

BaseAgentConnection.prototype.on_highlight = function (req) {
  var self = this,
    buf,
    valid_range = true;
  log.debug("agent.js: agent", self.id, "user", self.username, "highlighted", req.ranges);

  buf = self.room.get_buf(req.id);
  if (buf) {
    if (!_.isArray(req.ranges)) {
      return self.error(util.format("Can't highlight buffer %s: Ranges are not an array.", req.id));
    }
    _.each(req.ranges, function (range) {
      log.debug("range:", range);
      if (range.length !== 2) {
        valid_range = false;
        return;
      }
      // Make sure ranges are in order so lame editors don't have to swap them
      if (range[0] > range[1]) {
        var temp = range[0];
        range[0] = range[1];
        range[1] = temp;
      }
    });
    if (!valid_range) {
      return self.error(util.format("Can't highlight buffer %s: Ranges are not valid.", req.id));
    }
    if (_.isEqual(req, self.last_highlight)) {
      log.debug("agent sent the same highlight as before");
      return;
    }
    self.last_highlight = req;
    buf.highlight(self, req.ranges, req.ping);
  } else {
    self.error(util.format("Can't highlight buffer %s. It doesn't exist", req.id));
  }
};

BaseAgentConnection.prototype.on_msg = function (req) {
  var self = this;
  self.room.on_msg(self, req.data);
};

BaseAgentConnection.prototype.on_create_term = function (req) {
  var self = this;
  self.room.create_term(self, req.term_name, req.size);
};

BaseAgentConnection.prototype.on_delete_term = function (req) {
  var self = this;
  self.room.delete_term(self, req.id);
};

BaseAgentConnection.prototype.on_saved = function (req) {
  var self = this;
  self.room.on_saved(self, req);
};

BaseAgentConnection.prototype.get_term_or_error = function (term_id, owner_only, cb) {
  var self = this,
    term;

  term = self.room.get_term(term_id);
  if (!term) {
    return self.error(util.format("Terminal %s doesn't exist", term_id));
  }
  if (owner_only && self.id !== term.owner.id) {
    self.error(util.format("Only the terminal owner can perform this action."));
    return;
  }
  return cb(term);
};

BaseAgentConnection.prototype.on_update_term = function (req) {
  var self = this;

  self.get_term_or_error(req.id, true, function (term) {
    term.update(self, req);
  });
};

BaseAgentConnection.prototype.on_term_stdin = function (req) {
  var self = this;

  self.get_term_or_error(req.id, false, function (term) {
    term.stdin(self, req.data);
  });
};

BaseAgentConnection.prototype.on_term_stdout = function (req) {
  var self = this;

  self.get_term_or_error(req.id, true, function (term) {
    term.stdout(req.data);
  });
};

BaseAgentConnection.prototype.on_kick = function (req) {
  var self = this,
    agent;
  if (req === undefined || !_.isFinite(req.user_id)) {
    self.error("You tried to kick someone, but you didn't specify the user_id.");
    return;
  }
  agent = self.room.agents[req.user_id];
  if (agent) {
    agent.disconnect("Kicked by " + self.username);
  } else {
    self.error("user id " + req.user_id + " doesn't exist");
  }
};

BaseAgentConnection.prototype.on_delete_temp_data = function (req) {
  var self = this;
  self.room.delete_temp_data(self, req.data);
};

BaseAgentConnection.prototype.on_set_temp_data = function (req) {
  var self = this;
  if (!_.isObject(req.data)) {
    return self.error("Invalid temp data.");
  }
  self.room.set_temp_data(self, req.data);
};

BaseAgentConnection.prototype.on_pull_repo = function (req) {
  var self = this;

  function cb(err, result) {
    log.debug("Updated repo for", self.room.toString());
    if (err) {
      return self.error("Error pulling repository: " + err, true);
    }
    self.room.save();
  }

  if (self.room.repo && _.isEqual(req, self.room.repo.to_json())) {
    self.room.repo.update(cb);
  } else {
    try {
      self.room.repo = new Repo(self.room, req);
    } catch (e) {
      self.error("Error creating repository:" + e.toString(), true);
      return;
    }
    self.room.repo.clone(cb);
  }
};

BaseAgentConnection.prototype.on_request_perms = function (req) {
  var self = this;
  self.room.request_perms(self, req.perms);
};

BaseAgentConnection.prototype.on_perms = function (req) {
  var self = this,
    action = req.action,
    fine_grained_perms = [],
    user,
    invalid_perms = [];

  user = self.room.agents[req.user_id];
  if (_.isUndefined(user)) {
    return self.error("User doesn't exist.");
  }

  if (action === "reject") {
    return user.error(util.format("Your request for %s permission was rejected by %s", req.perms, self.username));
  }

  _.each(req.perms, function (perm) {
    var perms_list = perms.db_perms_mapping[perm];
    if (!perms_list) {
      invalid_perms = invalid_perms.concat(perm);
      return;
    }
    fine_grained_perms = fine_grained_perms.concat(perms_list);
  });

  if (invalid_perms.length > 0) {
    return self.error("Invalid permissions: " + JSON.stringify(invalid_perms));
  }

  fine_grained_perms = _.uniq(fine_grained_perms);

  if (action === "add") {
    user.perms = user.perms.concat(fine_grained_perms);
  } else if (action === "remove") {
    user.perms = _.difference(user.perms, fine_grained_perms);
  } else {
    return self.error("Unknown action:" + action);
  }
  user.perms = _.uniq(user.perms);

  perms.for_room(user.user_id, self.room.id, false, function (err, perms_list) {
    if (err) {
      log.error(err);
      return;
    }

    if (action === "add") {
      perms_list = perms_list.concat(req.perms);
    } else if (action === "remove") {
      perms_list = _.difference(req.perms, perms_list);
    }
    perms_list = _.uniq(perms_list);

    if (user.is_anon === false) {
      perms.set(user.user_id, self.room.id, perms_list, function (err, updated_perms) {
        if (err) {
          log.error("NOOO we couldn't set perms", updated_perms, "for user", user.username, ":", err);
          return;
        }
        log.log("Hooray. We set perms:", updated_perms, user.username);
      });
    }
  });

  user.allow(user.perms);

  self.room.emit("dmp", self, "perms", {
    "action": action,
    "user_id": user.id,
    "perms": fine_grained_perms
  });

  self.room.emit("dmp", self, "user_info", {
    "action": "update",
    "user_id": user.id,
    "user_info": user.to_json()
  });
};

BaseAgentConnection.prototype.on_dmp = function (source_client, action, json) {
  var self = this;
  if (source_client && source_client.id === self.id && _.contains(BROADCAST_ACTIONS, action) === false) {
    log.debug("action", action, "not sending to source client", self.id);
  } else {
    self.write(action, json);
  }
};


var AgentConnection = function (id, conn, server) {
  var self = this;

  BaseAgentConnection.call(self, id, conn, server);

  self.on("create_buf", self.on_create_buf.bind(self));
  self.on("delete_buf", self.on_delete_buf.bind(self));
  self.on("get_buf", self.on_get_buf.bind(self));
  self.on("rename_buf", self.on_rename_buf.bind(self));

  self.on("highlight", self.on_highlight.bind(self));
  self.on("kick", self.on_kick.bind(self));
  self.on("msg", self.on_msg.bind(self));
  self.on("saved", self.on_saved.bind(self));
  self.on("patch", self.on_patch.bind(self));
  self.on("pull_repo", self.on_pull_repo.bind(self));

  self.on("create_term", self.on_create_term.bind(self));
  self.on("delete_term", self.on_delete_term.bind(self));
  self.on("update_term", self.on_update_term.bind(self));
  self.on("term_stdin", self.on_term_stdin.bind(self));
  self.on("term_stdout", self.on_term_stdout.bind(self));

  self.on("delete_temp_data", self.on_delete_temp_data.bind(self));
  self.on("set_temp_data", self.on_set_temp_data.bind(self));

  self.on("request_perms", self.on_request_perms.bind(self));
  self.on("perms", self.on_perms.bind(self));

  conn.on("data", self.on_data.bind(self));
  conn.on("error", self.disconnect.bind(self));
  conn.on("end", function () {
    self.emit("on_conn_end", self);
  });

  self.buf = "";
  // XXXX: why isn't this in base agent connection?
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
  var self = this,
    auth_data,
    handle_msg,
    msg,
    newline_index;

  handle_msg = function (msg) {
    try {
      msg = JSON.parse(msg);
    } catch (e) {
      log.error("couldn't parse json:", msg, "error:", e);
      return self.disconnect();
    }

    if (!self.authenticated) {
      return self.auth(msg, function () {});
    }

    if (_.contains(self.perms, msg.name)) {
      log.debug("emitting", msg.name, "event");
      return self.emit(msg.name, msg);
    }

    log.error("action", msg.name, "not allowed");
    return self.disconnect();
  };

  log.debug("d: |" + d + "|");

  self.buf += d;

  newline_index = self.buf.indexOf("\n");
  while (newline_index !== -1) {
    msg = self.buf.slice(0, newline_index);
    self.buf = self.buf.slice(newline_index + 1);
    handle_msg(msg);
    newline_index = self.buf.indexOf("\n");
  }
};

AgentConnection.prototype.write = function (name, json) {
  var self = this,
    str;
  json.name = name;
  str = JSON.stringify(json);
  log.debug("writing to conn", self.id, ":", str);
  try {
    self.conn.write(str + "\n");
  } catch (e) {
    log.error("error writing to client:", e, "disconnecting");
    if (name !== "disconnect") {
      self.disconnect();
    }
  }
};

var SIOAgentConnection = function (id, conn, server) {
  var self = this;

  BaseAgentConnection.call(self, id, conn, server);

  conn.on("auth", function (auth_data) {
    self.auth(auth_data, function (err, result) {
      log.debug("allowed actions:", result.perms);
      self.allow(result.perms);
    });
  });
  conn.on("disconnect", function () {
    self.emit("on_conn_end", self);
  });
};

util.inherits(SIOAgentConnection, BaseAgentConnection);

SIOAgentConnection.prototype.allow = function (actions) {
  var self = this;

  _.each(perms.all_perms, function (action) {
    self.conn.removeAllListeners(action);
  });

  _.each(actions, function (action) {
    // Socket.io has no on_data
    var method = self["on_" + action];
    if (!method) {
      log.error("Unknown allowed action:", action);
      return;
    }
    self.conn.on(action, method.bind(self));
  });
};

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
