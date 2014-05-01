/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var events = require("events");
var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var Repo = require("./repo");
var Room = require("./room");
var db = require("./db");
var MSG = require("./msg");
var perms = require("./perms");
var utils = require("./utils");
var settings = require('./settings');

var SUPPORTED_VERSIONS = [0.01, 0.02, 0.03, 0.1, 0.11];
// Actions sent to everyone, including the client that sent the action
var BROADCAST_ACTIONS = ["create_buf", "delete_buf", "rename_buf", "create_term", "delete_term", "user_info"];

var CONN_STATES = {
  AUTH_WAIT: 1,
  JOINED: 2,
  DISCONNECTING: 3,
  DESTROYED: 4
};

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
  self.dmp_listener = self.on_dmp.bind(self);
  self.is_ssl = null;
  self.remote_address = self._remote_address();

  // TODO: merge all of these into a single variable that reflects connection state
  self.state = CONN_STATES.AUTH_WAIT;

  self.last_highlight = {};
  self.interval = null;

  self._joined_at = null;
  self._patch_count = 0;
  self._patch_bytes = 0;

  self.bad_perm_requests = 0;
  self.request_perms_timeout = 0;

  self.perms = [];
  self.auth_timeout_id = setTimeout(self.disconnect_unauthed_client.bind(self), 10000);
  self.heartbeat = null;
  self.idle_timeout = null;
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

BaseAgentConnection.prototype.start_metrics = function () {
  var self = this;

  self._joined_at = Date.now() / 1000;
  self.interval = setInterval(self._send_metrics.bind(self), 5 * 60 * 1000);
};

BaseAgentConnection.prototype.stop_metrics = function () {
  var self = this;

  clearInterval(self.interval);
  self._send_metrics(true);
  self._joined_at = null;
};

BaseAgentConnection.prototype._send_metrics = function (force) {
  var self = this,
    data,
    now;

  if (!_.isFinite(self._joined_at) || self._joined_at < 1 || self.is_anon) {
    return;
  }

  if ((self._patch_count === 0 || self._patch_bytes === 0) && !force) {
    return;
  }

  now = Date.now() / 1000;
  data = {
    "patch_count": self._patch_count,
    "patch_bytes": self._patch_bytes,
    "username": self.username,
    "odometer": Math.round(now - self._joined_at)
  };

  self._patch_count = 0;
  self._patch_bytes = 0;
  self._joined_at = now;
  log.debug("Metric data: %s", JSON.stringify(data));
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

  if (self.state >= CONN_STATES.DISCONNECTING) {
    return cb && cb();
  }

  self.state = CONN_STATES.DISCONNECTING;

  log.log("Disconnecting client %s ip %s. Reason: %s", self.toString(), self.remote_address, reason);
  if (reason) {
    return self.write("disconnect", {reason: reason}, function () {
      self.destroy();
      return cb && cb();
    });
  }

  self.destroy();
  return cb && cb();
};

BaseAgentConnection.prototype.destroy = function () {
  var self = this;

  if (self.state === CONN_STATES.DESTROYED) {
    return;
  }

  self.state = CONN_STATES.DESTROYED;

  clearInterval(self.heartbeat);
  clearTimeout(self.heartbeat);
  clearTimeout(self.idle_timeout);
  clearTimeout(self.auth_timeout_id);

  try {
    self.stop_metrics();
  } catch (ignore) { }

  try {
    self.room.removeListener("dmp", self.dmp_listener);
  } catch (e) {
    log.error("Error removing dmp listener for connection %s: %s", self.toString(), e);
  }

  try {
    self.conn.end();
    self.conn.destroy();
  } catch (e) {
    log.error("Error destroying connection for %s: %s", self.toString(), e);
  }

  try {
    self.room.part(self);
  } catch (e) {
    log.error("Couldn't part client %s: %s", self.toString(), e);
  }
};

BaseAgentConnection.prototype._is_ssl = function () {
  var self = this;
  if (self.conn) {
    if (self.conn.manager && self.server.server_ssl === self.conn.manager.server) {
      return true;
    }
    if (self.conn.socket && self.server.server_ssl === self.conn.socket.server) {
      return true;
    }
  }
  return false;
};

var pending_creds = {};

var send_credentials = function (supplier, requester, credentials) {
  if (supplier.remote_address !== requester.remote_address) {
    log.error("IP addresses don't match! requester:", requester.remote_address, "supplier:", supplier.remote_address);
  }

  requester.write("credentials", {credentials: credentials});
  supplier.write("success", {
    requester: {
      client: requester.client,
      platform: requester.platform,
      version: requester.version
    }
  });
  requester.destroy();
  supplier.destroy();
};

BaseAgentConnection.prototype.create_user = function (data) {
  var self = this;

  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = setTimeout(function () {
    self.disconnect("Timed out waiting for user creation to finish.");
  }, 20 * 1000);

  perms.create_user(data.username, function (err, user_info) {
    if (err) {
      self.error(err, true);
    } else {
      self.write("create_user", user_info);
    }
    return self.destroy();
  });
};

BaseAgentConnection.prototype.request_credentials = function (data) {
  var self = this,
    creds;

  self.handle_forwarded_options(data);

  log.debug("request_credentials", data);
  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = setTimeout(function () {
    delete pending_creds[data.token];
    self.disconnect("Timed out waiting for browser to supply credentials.");
  }, 20 * 1000);

  self.client = data.client;
  self.platform = data.platform;
  self.version = data.version;

  creds = pending_creds[data.token];
  if (creds && creds.supplier) {
    send_credentials(creds.supplier, self, creds.credentials);
    delete pending_creds[data.token];
  } else {
    pending_creds[data.token] = {
      requester: self
    };
  }
};

BaseAgentConnection.prototype.supply_credentials = function (data) {
  var self = this,
    creds;

  self.handle_forwarded_options(data);

  log.debug("supplying credentials", data);
  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = setTimeout(function () {
    delete pending_creds[data.token];
    self.disconnect("Timed out waiting for native editor to request credentials.");
  }, 20 * 1000);

  creds = pending_creds[data.token];
  if (creds && creds.requester) {
    send_credentials(self, creds.requester, data.credentials);
    delete pending_creds[data.token];
  } else {
    pending_creds[data.token] = {
      supplier: self,
      credentials: data.credentials
    };
  }
};

BaseAgentConnection.prototype.auth = function (auth_data, cb) {
  var self = this,
    auto,
    OK = true;

  if (!_.isString(auth_data.username) && !_.isString(auth_data.api_key)) {
    OK = false;
  }
  _.each(["secret", "room_owner", "room", "version"], function (key) {
    if (!_.has(auth_data, key)) {
      OK = false;
    }
  });

  if (!OK) {
    return self.disconnect("Bad auth JSON");
  }
  auth_data.version = Number(auth_data.version);
  if (!_.contains(SUPPORTED_VERSIONS, auth_data.version)) {
    return self.disconnect(util.format("Unsupported client version: %s; disconnecting client.", auth_data.version));
  }

  self.username = auth_data.username;
  self.api_key = auth_data.api_key;
  self.secret = auth_data.secret;
  self.client = auth_data.client || "";
  self.client = self.client.slice(0, 30);
  self.version = auth_data.version;
  self.platform = auth_data.platform;

  if (self.client === "flootty" && self.version < 0.1) {
    return self.disconnect("Sorry, you need to update flootty to version 1.10 or greater. Please run 'pip install --upgrade flootty'");
  }

  self.handle_forwarded_options(auth_data);

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
      if (auth_data.api_key) {
        return db.get_user_by_api_key(auth_data.api_key, function (err, result) {
          if (err) {
            return cb("Invalid API key or secret", result);
          }
          log.debug("Got user", result.id, "from API key", auth_data.api_key);
          return cb(err, result);
        });
      }
      db.get_user(auth_data.username, function (err, result) {
        if (err) {
          return cb("Invalid username or secret", result);
        }
        log.debug("Got user", result.id, "from username", auth_data.username);
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
      log.log("Authenticated client %s user %s", self.toString(), self.username);
      self.state = CONN_STATES.JOINED;
      Room.add_agent(auth_data.room_owner, auth_data.room, self, res.user, cb);
    }]
  };
  return async.auto(auto, function (err, result) {
    var room_info;

    if (err || !result.room) {
      log.warn("Error adding agent %s: %s", self.toString(), err);
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
    room_info.motd = self.server.motd;

    self.start_metrics();
    self.write("room_info", room_info);
    self.room.on("dmp", self.dmp_listener);
    self.room.emit("dmp", self, "join", self.to_json());

    _.each(self.room.msgs, function (msg) {
      self.write("msg", msg.to_json());
    });

    if (self.room.last_highlight) {
      self.write("highlight", self.room.last_highlight);
    }

    if (self.version > 0.1) {
      self.on_pong();
    } else {
      // Older clients don't respond to ping, but keep the connection active so ELB doesn't disconnect them
      self.heartbeat = setInterval(self.write.bind(self, "ping", {}), 15000);
    }

    return cb(null, self);
  });
};

BaseAgentConnection.prototype.handle_forwarded_options = function (data) {
  var self = this,
    opts = data._forward_options;

  // TODO: only allow forwarded options from private IPs
  if (opts) {
    // Forwarded connection from colabalancer
    self.is_ssl = opts.ssl;
    self.remote_address = opts.remote_address;
  } else {
    // Direct connection from client
    self.is_ssl = self._is_ssl();
    self.remote_address = self._remote_address();
  }
};

BaseAgentConnection.prototype.on_ping = function () {
  var self = this;
  self.write("pong", {});
};

BaseAgentConnection.prototype.on_pong = function () {
  var self = this;

  clearTimeout(self.idle_timeout);
  self.idle_timeout = setTimeout(self.disconnect.bind(self), 60000);
  clearTimeout(self.heartbeat);
  self.heartbeat = setTimeout(self.write.bind(self, "ping", {}), 15000);
};

BaseAgentConnection.prototype.on_patch = function (req) {
  var self = this,
    buf = self.room.get_buf(req.id);
  // TODO: this could falsely trigger if someone's typing in a buffer that another user deletes
  if (!buf) {
    self.disconnect("Your client tried to patch a buffer that doesn't exist.");
    return;
  }
  if (self.room.readme_buf && buf.id === self.room.readme_buf.id) {
    self.room.readme_buf = null;
  }
  buf.patch(self, req.patch, req.md5_before, req.md5_after);
};

BaseAgentConnection.prototype.on_set_buf = function (req) {
  var self = this,
    buf = self.room.get_buf(req.id);
  // TODO: this could falsely trigger if someone's typing in a buffer that another user deletes
  if (buf) {
    return buf.set(self, req.buf, req.md5, req.encoding, function (err) {
      if (err) {
        self.error(err);
      }
    });
  }
  self.on_create_buf(req);
};

BaseAgentConnection.prototype.on_get_buf = function (req) {
  var self = this,
    buf = self.room.get_buf(req.id);
  if (!buf) {
    self.error(util.format("Buffer with id %s doesn't exist", req.id));
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

  if (!req.encoding) {
    log.warn(util.format("old client %s didn't specify encoding. defaulting to utf8", self.toString()));
    req.encoding = "utf8";
  }

  self.room.create_buf(req.path, req.buf, req.encoding, self, function (err) {
    if (err) {
      self.error("create buf failed: " + err);
    }
  });
};

BaseAgentConnection.prototype.on_delete_buf = function (req) {
  var self = this;
  self.room.delete_buf(req.id, self, req.unlink, function (err) {
    if (err) {
      self.error(util.format("Error deleting buffer %s: %s", req.id, err));
    }
  });
};

BaseAgentConnection.prototype.on_rename_buf = function (req) {
  var self = this;
  log.debug("renaming buf", req);
  self.room.rename_buf(req.id, req.path, self, function (err) {
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
    buf.highlight(self, req);
  } else {
    self.error(util.format("Can't highlight buffer %s. It doesn't exist", req.id));
  }
};

BaseAgentConnection.prototype.on_msg = function (req) {
  var self = this;
  self.room.on_msg(self, req.data);
};

BaseAgentConnection.prototype.on_datamsg = function (req) {
  var self = this;

  if (!_.isArray(req.to) || !req.data) {
    return;
  }

  self.room.on_datamsg(self, req);
};

BaseAgentConnection.prototype.on_create_term = function (req) {
  var self = this;
  self.room.create_term(self, req.term_name, req.size, req.id, function (err, result) {
    if (err) {
      return self.error(err);
    }
    log.log(self.toString(), "created terminal", result.toString());
  });
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
    self.error(util.format("User id %s doesn't exist.", req.user_id));
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

  function cb(err) {
    log.log("%s updated repo for %s", self.toString(), self.room.toString());
    if (err) {
      return self.error(err, true);
    }
    self.room.save();
  }

  if (self.room.repo && _.isEqual(req, self.room.repo.to_json())) {
    self.room.repo.update(self, cb);
  } else {
    try {
      self.room.repo = new Repo(self.room, req);
    } catch (e) {
      self.error("Error creating repository:" + e.toString(), true);
      return;
    }
    self.room.repo.clone(self, cb);
  }
};

BaseAgentConnection.prototype.on_request_perms = function (req) {
  var self = this,
    admins,
    timeout,
    now = Date.now();

  admins = self.room.get_admins();

  if (_.isEmpty(admins)) {
    return self.error("Permission request failed: There are no admins in this workspace.", true);
  }

  if (self.request_perms_timeout > now) {
    return self.error(util.format("You can not make another request for %s seconds.", (self.request_perms_timeout - now) / 1000));
  }

  self.bad_perm_requests += 1;
  timeout = Math.min(Math.pow(2, self.bad_perm_requests), 60 * 60);
  self.request_perms_timeout = now + (timeout * 1000);

  _.each(admins, function (admin) {
    admin.write("request_perms", {
      user_id: self.id,
      perms: req.perms
    });
  });
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
    return user.error(util.format("Your request for %s permission was rejected by %s", req.perms, self.username), true);
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
  } else if (action === "set") {
    user.perms = fine_grained_perms;
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
      user.request_perms_timeout = 0;
      user.bad_perm_requests = 0;
    } else if (action === "remove") {
      perms_list = _.difference(req.perms, perms_list);
    } else if (action === "set") {
      perms_list = req.perms;
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
  if (!source_client || source_client.id !== self.id || _.contains(BROADCAST_ACTIONS, action)) {
    self.write(action, json);
  }
};

BaseAgentConnection.prototype.disconnect_unauthed_client = function () {
  var self = this;
  if (self.state > CONN_STATES.AUTH_WAIT) {
    log.debug("client authed before timeout, but this interval should have been cancelled");
  } else {
    self.disconnect("Took too long to send auth info.");
  }
};

var AgentConnection = function (id, conn, server) {
  var self = this;

  BaseAgentConnection.call(self, id, conn, server);

  conn.on("data", self.on_data.bind(self));
  conn.on("error", self.disconnect.bind(self));
  conn.on("close", function () {
    self.emit("on_conn_end", self);
  });

  self.buf = "";
};

util.inherits(AgentConnection, BaseAgentConnection);

AgentConnection.prototype.handle_msg = function (msg) {
  var self = this, f_name;

  try {
    msg = JSON.parse(msg);
  } catch (e) {
    log.error("couldn't parse json:", msg, "error:", e);
    return self.disconnect();
  }

  if (self.state === CONN_STATES.AUTH_WAIT) {
    switch (msg.name) {
    case "request_credentials":
      return self.request_credentials(msg);
    case "supply_credentials":
      return self.supply_credentials(msg);
    case "create_user":
      return self.create_user(msg);
    default:
      return self.auth(msg, function () { return; });
    }
  }

  if (!_.contains(self.perms, msg.name)) {
    log.error("action", msg.name, "not allowed");
    return self.disconnect();
  }

  f_name = "on_" + msg.name;
  try {
    log.debug("Calling %s", f_name);
    self[f_name](msg);
  } catch (e) {
    log.error("%s calling %s msg %s", self.toString(), f_name, msg, e);
    return self.disconnect();
  }
};

AgentConnection.prototype.on_data = function (d) {
  var self = this,
    msg,
    newline_index;

  log.debug("d: |" + d + "|");

  self.buf += d;

  // TODO: better limit here
  if (self.buf.length > settings.max_buf_len) {
    return self.disconnect("Sorry. Your client sent a message that is too big.");
  }
  // TODO: Don't need to do this for self.buf, just d
  newline_index = self.buf.indexOf("\n");
  while (newline_index !== -1) {
    msg = self.buf.slice(0, newline_index);
    self.buf = self.buf.slice(newline_index + 1);
    self.handle_msg(msg);
    newline_index = self.buf.indexOf("\n");
  }
};

AgentConnection.prototype.write = function (name, json, cb) {
  var self = this,
    str;

  if (self.state >= CONN_STATES.DESTROYED) {
    log.error("Somebody called write after we destroyed connection %s!", self.id);
    log.error("Event: %s %s", name, JSON.stringify(json));
    console.trace();
    return cb && cb();
  }
  json.name = name;
  str = JSON.stringify(json);
  log.debug("writing to conn", self.id, ":", str);
  try {
    self.conn.write(str);
    self.conn.write("\n", cb);
  } catch (e) {
    log.error("error writing to client %s: %s. disconnecting.", self.toString(), e);
    self.destroy();
    return cb && cb();
  }
};

AgentConnection.prototype._remote_address = function () {
  var self = this;
  return self.conn.remoteAddress;
};

module.exports = {
  "AgentConnection": AgentConnection
};
