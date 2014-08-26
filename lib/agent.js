/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var events = require("events");
var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var api_client = require("./api_client");
var MSG = require("./msg");
var Repo = require("./repo");
var Room = require("./room");
var perms = require("./perms");
var utils = require("./utils");
var settings = require('./settings');

var SUPPORTED_VERSIONS = [0.01, 0.02, 0.03, 0.1, 0.11];

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
  self.is_ssl = null;
  self.remote_address = self._remote_address();

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
  self.outstanding_reqs = {};
  self.cur_req_id = 0;
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

BaseAgentConnection.prototype.error = function (req_id, msg, flash) {
  var self = this;
  flash = !!flash;
  self.write("error", req_id, {"msg": msg, "flash": flash});
};

BaseAgentConnection.prototype.disconnect = function (reason, cb) {
  var self = this;

  if (self.state >= CONN_STATES.DISCONNECTING) {
    return cb && cb();
  }

  utils.set_state(self, CONN_STATES.DISCONNECTING);

  log.log("Disconnecting client %s ip %s. Reason: %s", self.toString(), self.remote_address, reason);
  if (reason) {
    return self.write("disconnect", null, {reason: reason}, function () {
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

  utils.set_state(self, CONN_STATES.DESTROYED);

  clearInterval(self.heartbeat);
  clearTimeout(self.heartbeat);
  clearTimeout(self.idle_timeout);
  clearTimeout(self.auth_timeout_id);

  try {
    self.stop_metrics();
  } catch (ignore) { }

  try {
    self.conn.end();
    self.conn.destroy();
  } catch (e) {
    log.error("Error destroying connection for %s: %s", self.toString(), e);
  }

  if (self.room) {
    self.room.part(self);
    self.room = null;
  } else {
    log.warn("Agent %s had no room when destroying", self.toString());
  }
  if (_.size(self.outstanding_reqs) > 0) {
    log.warn("%s outstanding reqs for destroyed client %s:", _.size(self.outstanding_reqs), self.toString());
    _.each(self.outstanding_reqs, function (req, req_id) {
      log.warn("%s: %s", req_id, req);
    });
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

  requester.write("credentials", null, {credentials: credentials});
  supplier.write("success", null, {
    requester: {
      client: requester.client,
      platform: requester.platform,
      version: requester.version
    }
  });
  log.log("%s sent credentials to %s", supplier.toString(), requester.toString());
  requester.destroy();
  supplier.destroy();
};

BaseAgentConnection.prototype.create_user = function (data) {
  var self = this;

  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = setTimeout(function () {
    self.disconnect("Timed out waiting for user creation to finish.");
  }, 20 * 1000);
  utils.set_state(self, CONN_STATES.JOINED);
  log.log("%s creating user %s...", self.toString(), data.username);

  api_client.user_create(data.username, function (err, user_info) {
    if (err) {
      self.error(null, err, true);
      log.warn("%s error creating user %s: %s", self.toString(), data.username, err);
    } else {
      self.write("create_user", null, user_info);
      log.log("%s created user %s", self.toString(), user_info.username);
    }
    return self.destroy();
  });
};

BaseAgentConnection.prototype.request_credentials = function (data) {
  var self = this,
    creds;

  self.handle_forwarded_options(data);

  log.log("%s request credentials for %s %s %s", self.toString(), data.client, data.platform, data.version);
  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = setTimeout(function () {
    delete pending_creds[data.token];
    self.disconnect("Timed out waiting for browser to supply credentials.");
  }, 40 * 1000);
  utils.set_state(self, CONN_STATES.JOINED);

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

  log.log("%s supply credentials for %s", self.toString(), data.credentials && data.credentials.username);
  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = setTimeout(function () {
    delete pending_creds[data.token];
    self.disconnect("Timed out waiting for native editor to request credentials.");
  }, 40 * 1000);
  utils.set_state(self, CONN_STATES.JOINED);

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
    OK = true,
    room_path = auth_data.path;

  if (!_.isString(auth_data.username) && !_.isString(auth_data.api_key)) {
    log.warn("Client didn't username or api_key in auth data");
    OK = false;
  }
  _.each(["secret", "version"], function (key) {
    if (!_.has(auth_data, key)) {
      log.warn("Client didn't send %s in auth data", key);
      OK = false;
    }
  });

  if (auth_data.room_owner && auth_data.room) {
    room_path = util.format("%s/%s", auth_data.room_owner, auth_data.room);
  }

  if (!room_path) {
    log.warn("Client didn't send path or room info in auth data");
    OK = false;
  }

  if (!OK) {
    return self.disconnect("Bad auth JSON", cb);
  }
  auth_data.version = Number(auth_data.version);
  if (!_.contains(SUPPORTED_VERSIONS, auth_data.version)) {
    return self.disconnect(util.format("Unsupported client version: %s; disconnecting client.", auth_data.version), cb);
  }

  self.username = auth_data.username;
  self.api_key = auth_data.api_key;
  self.secret = auth_data.secret;
  self.client = auth_data.client || "";
  self.client = self.client.slice(0, 30);
  self.version = auth_data.version;
  self.platform = auth_data.platform;

  if (self.client === "flootty" && self.version < 0.1) {
    return self.disconnect("Sorry, you need to update flootty to version 1.10 or greater. Please run 'pip install --upgrade flootty'", cb);
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
      api_client.user_auth(auth_data, cb);
    },
    room: ["user", function (cb, res) {
      if (res.user.id === -1) {
        self.is_anon = true;
      }
      self.username = res.user.username;
      self.user_id = res.user.id;
      log.log("Authenticated client %s user %s", self.toString(), self.username);
      Room.add_agent(room_path, self, res.user, cb);
    }]
  };
  return async.auto(auto, function (err, result) {
    var room_info,
      replay_event_id;

    clearTimeout(self.auth_timeout_id);

    if (err || !result.room) {
      log.warn("Error adding agent %s: %s", self.toString(), err);
      self.disconnect(err);
      return cb(err, {perms: []});
    }
    utils.set_state(self, CONN_STATES.JOINED);
    if (self.state > CONN_STATES.JOINED) {
      log.log("client %s is in state %s. Disconnecting.", self.toString(), self.state);
      self.disconnect();
      return cb(err, {perms: []});
    }

    result.room.agents[self.id] = self;
    self.room = result.room;
    self.bufs = result.room.bufs;

    log.debug("client %s authenticated and joined room %s", self.toString(), self.room.name);

    room_info = self.room.to_json();
    // add_agent munges agent.perms :/
    room_info.perms = self.perms;
    room_info.user_id = self.id;
    room_info.motd = self.server.motd;

    self.start_metrics();
    self.write("room_info", null, room_info);
    self.room.broadcast("join", self, null, self.to_json());

    replay_event_id = self.room.part_event_ids[self.username] || 0;
    _.each(self.room.events, function (evt) {
      if (evt.id > replay_event_id && evt.name === "msg") {
        self.write(evt.name, null, evt.to_json());
      }
    });

    if (self.room.last_highlight) {
      self.write("highlight", null, self.room.last_highlight);
    }

    if (self.version > 0.1) {
      self.on_pong();
    } else {
      // Older clients don't respond to ping, but keep the connection active so ELB doesn't disconnect them
      self.heartbeat = setInterval(self.write.bind(self, "ping", null, {}), 15000);
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

BaseAgentConnection.prototype.on_ping = function (req_id) {
  var self = this;
  self.write("pong", req_id, {});
};

BaseAgentConnection.prototype.on_pong = function (req_id) {
  var self = this;

  clearTimeout(self.idle_timeout);
  self.idle_timeout = setTimeout(self.disconnect.bind(self), 60000);
  clearTimeout(self.heartbeat);
  self.heartbeat = setTimeout(self.write.bind(self, "ping", req_id, {}), 15000);
};

BaseAgentConnection.prototype.on_patch = function (req_id, req) {
  var self = this,
    buf = self.room.get_buf(req.id);
  if (!buf) {
    self.error(req_id, util.format("Buffer %s doesn't exist", req.id));
    return;
  }
  if (self.room.readme_buf && buf.id === self.room.readme_buf.id) {
    self.room.readme_buf = null;
  }
  buf.patch(self, req_id, req.patch, req.md5_before, req.md5_after);
};

BaseAgentConnection.prototype.on_set_buf = function (req_id, req) {
  var self = this,
    buf = self.room.get_buf(req.id);
  // TODO: this could falsely trigger if someone's typing in a buffer that another user deletes
  if (!buf) {
    self.on_create_buf(req_id, req);
    return;
  }
  buf.set(self, req_id, req.buf, req.md5, req.encoding, false, function (err) {
    if (err) {
      self.error(req_id, err);
    }
  });
};

BaseAgentConnection.prototype.on_get_buf = function (req_id, req) {
  var self = this,
    buf = self.room.get_buf(req.id);
  if (!buf) {
    self.error(req_id, util.format("Buffer with id %s doesn't exist", req.id));
    return;
  }
  if (!buf.loaded) {
    buf.once("load", function () {
      buf.send_get_buf(self, req_id, 0);
    });
  } else {
    buf.send_get_buf(self, req_id, 0);
  }
};

BaseAgentConnection.prototype.on_create_buf = function (req_id, req) {
  var self = this;

  if (!req.encoding) {
    log.warn(util.format("old client %s didn't specify encoding. defaulting to utf8", self.toString()));
    req.encoding = "utf8";
  }

  self.room.create_buf(self, req_id, req.path, req.buf, req.encoding, function (err) {
    if (err) {
      self.error(req_id, "create buf failed: " + err);
    }
  });
};

BaseAgentConnection.prototype.on_delete_buf = function (req_id, req) {
  var self = this;
  self.room.delete_buf(self, req_id, req.id, req.unlink, function (err) {
    if (err) {
      self.error(req_id, util.format("Error deleting buffer %s: %s", req.id, err));
    }
  });
};

BaseAgentConnection.prototype.on_rename_buf = function (req_id, req) {
  var self = this;
  self.room.rename_buf(self, req_id, req.id, req.path, function (err) {
    if (err) {
      log.error("error renaming buf:", err);
      self.error(req_id, util.format("Error renaming buffer %s to %s: %s", req.id, req.path, err), true);
    }
  });
};

BaseAgentConnection.prototype.on_highlight = function (req_id, req) {
  var self = this,
    buf,
    valid_range = true;
  log.debug("agent.js: agent", self.id, "user", self.username, "highlighted", req.ranges);

  buf = self.room.get_buf(req.id);
  if (!buf) {
    return self.error(req_id, util.format("Can't highlight buffer %s. It doesn't exist", req.id));
  }
  if (!_.isArray(req.ranges)) {
    return self.error(req_id, util.format("Can't highlight buffer %s: Ranges are not an array.", req.id));
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
    return self.error(req_id, util.format("Can't highlight buffer %s: Ranges are not valid.", req.id));
  }
  if (_.isEqual(req, self.last_highlight)) {
    log.debug("agent sent the same highlight as before");
    return self.ack(req_id);
  }
  self.last_highlight = req;
  buf.highlight(self, req);
};

BaseAgentConnection.prototype.on_msg = function (req_id, req) {
  var self = this;
  self.room.on_msg(self, req_id, req.data);
};

BaseAgentConnection.prototype.on_datamsg = function (req_id, req) {
  var self = this;

  if (!_.isArray(req.to) || !req.data) {
    return;
  }

  self.room.on_datamsg(self, req_id, req);
};

BaseAgentConnection.prototype.on_create_term = function (req_id, req) {
  var self = this;
  self.room.create_term(self, req.term_name, req.size, req.id, function (err, result) {
    if (err) {
      return self.error(req_id, err);
    }
    log.log(self.toString(), "created terminal", result.toString());
  });
};

BaseAgentConnection.prototype.on_delete_term = function (req_id, req) {
  var self = this;
  self.room.delete_term(self, req_id, req.id);
};

BaseAgentConnection.prototype.on_saved = function (req_id, req) {
  var self = this;

  self.room.broadcast("saved", self, req_id, {
    id: req.id,
    user_id: self.id
  });
};

BaseAgentConnection.prototype.get_term_or_error = function (term_id, owner_only, cb) {
  var self = this,
    term;

  term = self.room.get_term(term_id);
  if (!term) {
    return self.error(null, util.format("Terminal %s doesn't exist", term_id));
  }
  if (owner_only && self.id !== term.owner.id) {
    self.error(null, util.format("Only the terminal owner can perform this action."));
    return;
  }
  return cb(term);
};

BaseAgentConnection.prototype.on_update_term = function (req_id, req) {
  var self = this;

  self.get_term_or_error(req.id, true, function (term) {
    term.update(self, req_id, req);
  });
};

BaseAgentConnection.prototype.on_term_stdin = function (req_id, req) {
  var self = this;

  self.get_term_or_error(req.id, false, function (term) {
    term.stdin(self, req_id, req.data);
  });
};

BaseAgentConnection.prototype.on_term_stdout = function (req_id, req) {
  var self = this;

  self.get_term_or_error(req.id, true, function (term) {
    term.stdout(req_id, req.data);
  });
};

BaseAgentConnection.prototype.on_kick = function (req_id, req) {
  var self = this,
    agent;
  if (req === undefined || !_.isFinite(req.user_id)) {
    self.error(req_id, "You tried to kick someone, but you didn't specify the user_id.");
    return;
  }
  agent = self.room.agents[req.user_id];
  if (agent) {
    agent.disconnect(util.format("Kicked by %s", self.username));
    self.ack(req_id);
  } else {
    self.error(req_id, util.format("User id %s doesn't exist.", req.user_id));
  }
};

BaseAgentConnection.prototype.on_delete_temp_data = function (req_id, req) {
  var self = this;
  self.room.delete_temp_data(self, req_id, req.data);
};

BaseAgentConnection.prototype.on_set_temp_data = function (req_id, req) {
  var self = this;
  if (!_.isObject(req.data)) {
    return self.error(req_id, "Invalid temp data.");
  }
  self.room.set_temp_data(self, req.data);
};

BaseAgentConnection.prototype.on_pull_repo = function (req_id, req) {
  var self = this;

  function cb(err) {
    var room = self.room || "(no room)";
    if (err) {
      log.error("%s error updating repo for %s: %s", self.toString(), room.toString(), err);
      return self.error(req_id, err, true);
    }
    log.log("%s updated repo for %s", self.toString(), room.toString());
    self.room.save();
    self.ack(req_id);
  }

  if (self.room.repo && _.isEqual(req, self.room.repo.to_json())) {
    self.room.repo.update(self, req_id, cb);
  } else {
    try {
      self.room.repo = new Repo(self.room, req);
    } catch (e) {
      self.error(req_id, "Error creating repository:" + e.toString(), true);
      return;
    }
    self.room.repo.clone(self, req_id, cb);
  }
};

BaseAgentConnection.prototype.on_request_perms = function (req_id, req) {
  var self = this,
    admins,
    timeout,
    now = Date.now();

  admins = self.room.get_admins();

  if (_.isEmpty(admins)) {
    return self.error(req_id, "Permission request failed: There are no admins in this workspace.", true);
  }

  if (self.request_perms_timeout > now) {
    return self.error(req_id, util.format("You can not make another request for %s seconds.", (self.request_perms_timeout - now) / 1000));
  }

  self.bad_perm_requests += 1;
  timeout = Math.min(Math.pow(2, self.bad_perm_requests), 60 * 60);
  self.request_perms_timeout = now + (timeout * 1000);

  _.each(admins, function (admin) {
    admin.write("request_perms", req_id, {
      user_id: self.id,
      perms: req.perms
    });
  });
  self.ack(req_id);
};

BaseAgentConnection.prototype.on_perms = function (req_id, req) {
  var self = this,
    action = req.action,
    fine_grained_perms = [],
    user,
    invalid_perms = [];

  user = self.room.agents[req.user_id];
  if (_.isUndefined(user)) {
    return self.error(req_id, "User doesn't exist.");
  }

  if (action === "reject") {
    return user.error(req_id, util.format("Your request for %s permission was rejected by %s", req.perms, self.username), true);
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
    return self.error(req_id, "Invalid permissions: " + JSON.stringify(invalid_perms));
  }

  fine_grained_perms = _.uniq(fine_grained_perms);

  if (action === "add") {
    user.perms = user.perms.concat(fine_grained_perms);
  } else if (action === "remove") {
    user.perms = _.difference(user.perms, fine_grained_perms);
  } else if (action === "set") {
    user.perms = fine_grained_perms;
  } else {
    return self.error(req_id, "Unknown action:" + action);
  }
  user.perms = _.uniq(user.perms);

  api_client.perms_for_room(user.user_id, self.room.id, false, function (err, perms_list) {
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
      api_client.perms_set(user.user_id, self.room.id, perms_list, function (err, updated_perms) {
        if (err) {
          log.error("NOOO we couldn't set perms", updated_perms, "for user", user.username, ":", err);
          return;
        }
        log.log("Hooray. We set perms:", updated_perms, user.username);
      });
    }
  });

  self.room.broadcast("perms", self, null, {
    "action": action,
    "user_id": user.id,
    "perms": fine_grained_perms
  });

  self.room.broadcast("user_info", self, null, {
    "action": "update",
    "user_id": user.id,
    "user_info": user.to_json()
  });
};

BaseAgentConnection.prototype.disconnect_unauthed_client = function () {
  var self = this;
  if (self.state > CONN_STATES.AUTH_WAIT) {
    log.debug("client authed before timeout, but this interval should have been cancelled");
  } else {
    self.disconnect("Took too long to send auth info.");
  }
};

BaseAgentConnection.prototype.ack = function (req_id) {
  var self = this;

  if (!_.has(self.outstanding_reqs, req_id)) {
    log.warn("%s: %s is not in outstanding_reqs!", self.toString(), req_id);
  }

  delete self.outstanding_reqs[req_id];
  self.write("ack", req_id, {});
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
  var self = this, f_name, req_id;

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
    if (_.has(msg, "req_id")) {
      // Make sure req_id is an integener that is higher than the last req_id
      if (msg.req_id % 1 === 0 && msg.req_id > self.cur_req_id) {
        req_id = msg.req_id;
        self.cur_req_id = req_id;
        self.outstanding_reqs[req_id] = msg.name || "no name";
      } else {
        log.error("%s bad req_id: %s", self.toString(), msg.req_id);
        return self.disconnect();
      }
    }
    self[f_name](req_id, msg);
  } catch (e) {
    log.error("%s calling %s msg %s", self.toString(), f_name, msg, e);
    return self.disconnect();
  }
};

AgentConnection.prototype.on_data = function (d) {
  var self = this,
    buf_len = self.buf.length,
    d_index = d.indexOf("\n"),
    msg,
    newline_index;

  log.debug("d: |%s|", d);

  if (buf_len + Math.max(d_index, 0) > settings.max_buf_len) {
    return self.disconnect("Sorry. Your client sent a message that is too big.");
  }

  self.buf += d;

  if (d_index === -1) {
    return;
  }

  newline_index = buf_len + d_index;
  while (newline_index !== -1) {
    msg = self.buf.slice(0, newline_index);
    self.buf = self.buf.slice(newline_index + 1);
    self.handle_msg(msg);
    newline_index = self.buf.indexOf("\n");
  }
};

AgentConnection.prototype.write = function (name, res_id, json, cb) {
  var self = this,
    str;

  if (res_id) {
    delete self.outstanding_reqs[res_id];
    json.res_id = res_id;
  }

  if (self.state < CONN_STATES.JOINED) {
    log.warn("client %s: Discarding event %s because conn state is %s", self.toString(), name, self.state);
    return cb && cb();
  }
  if (self.state >= CONN_STATES.DESTROYED) {
    log.error("Somebody called write after we destroyed connection %s!", self.id);
    log.error("Event: %s", name);
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
