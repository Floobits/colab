/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var BaseAgentHandler = require("./base");
var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var MSG = require("./msg");
var Repo = require("./repo");
var Room = require("./room");
var perms = require("./perms");
var utils = require("./utils");
var api_client = require("../api_client");

function AgentHandler () {
  BaseAgentHandler.call(this, arguments);
  this.room = null;
  this.is_anon = false;
  this.username = null;
  this.gravatar = null;
  this.user_id = null;
  this.client = "";
  this.platform = null;
  this._patch_count = 0;
  this._patch_bytes = 0;
  this.bad_perm_requests = 0;
  this.request_perms_timeout = 0;
  this.last_highlight = {};
  this.perms = [];
}

util.inherits(AgentHandler, BaseAgentHandler);

AgentHandler.prototype.auth = function (auth_data) {
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
    return self.disconnect("Bad auth JSON");
  }
  auth_data.version = Number(auth_data.version);
  if (!_.contains(self.SUPPORTED_VERSIONS, auth_data.version)) {
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
      api_client.user_auth(auth_data, cb);
    },
    room: ["user", function (cb, res) {
      if (res.user.id === -1) {
        self.is_anon = true;
      }
      self.username = res.user.username;
      self.user_id = res.user.id;
      self.gravatar = res.user.gravatar;
      log.log("Authenticated client %s user %s", self.toString(), self.username);
      Room.add_agent(room_path, self, res.user, cb);
    }]
  };

  return self.safe_auto(auto, function (err, result) {
    var room_info, replay_event_id;

    clearTimeout(self.auth_timeout_id);

    if (err || !result.room) {
      log.warn("Error adding agent %s: %s", self.toString(), err);
      return self.disconnect(err);
    }
    utils.set_state(self, self.CONN_STATES.JOINED);
    if (self.state > self.CONN_STATES.JOINED) {
      log.log("client %s is in state %s. Disconnecting.", self.toString(), self.state);
      return self.disconnect();
    }

    result.room.handlers[self.id] = self;
    self.room = result.room;

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
  });
};

AgentHandler.prototype._conn_guard = function (f) {
  var self = this;

  function inner(cb) {
    // Return early if agent is disconnected
    if (self.state >= self.CONN_STATES.DISCONNECTING) {
      return cb(util.format("Agent is %s", self.CONN_STATES_REVERSE[self.state]));
    }
    return f.apply(self, arguments);
  }
  return inner;
};

AgentHandler.prototype.safe_auto = function (auto, cb) {
  var self = this;

  auto = _.mapValues(auto, function (f) {
    if (_.isArray(f)) {
      // Kinda lame. we're modifying the thing that's being passed in
      f[f.length - 1] = self._conn_guard(_.last(f));
      return f;
    }
    return self._conn_guard(f);
  });

  return async.auto(auto, cb);
};

AgentHandler.prototype.start_metrics = function () {
  var self = this;

  self._joined_at = Date.now() / 1000;
  self.metrics_interval = setInterval(self._send_metrics.bind(self), 5 * 60 * 1000);
};

AgentHandler.prototype.stop_metrics = function () {
  var self = this;

  clearInterval(self.metrics_interval);
  self._send_metrics(true);
  self._joined_at = null;
};

AgentHandler.prototype._send_metrics = function (force) {
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

AgentHandler.prototype.on_patch = function (req_id, req) {
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

AgentHandler.prototype.on_set_buf = function (req_id, req) {
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

AgentHandler.prototype.on_get_buf = function (req_id, req) {
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

AgentHandler.prototype.on_create_buf = function (req_id, req) {
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

AgentHandler.prototype.on_delete_buf = function (req_id, req) {
  var self = this;
  self.room.delete_buf(self, req_id, req.id, req.unlink, function (err) {
    if (err) {
      self.error(req_id, util.format("Error deleting buffer %s: %s", req.id, err));
    }
  });
};

AgentHandler.prototype.on_rename_buf = function (req_id, req) {
  var self = this;
  self.room.rename_buf(self, req_id, req.id, req.path, function (err) {
    if (err) {
      log.error("error renaming buf:", err);
      self.error(req_id, util.format("Error renaming buffer %s to %s: %s", req.id, req.path, err), true);
    }
  });
};

AgentHandler.prototype.on_highlight = function (req_id, req) {
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
  return self.ack(req_id);
};

AgentHandler.prototype.on_msg = function (req_id, req) {
  var self = this;
  self.room.on_msg(self, req_id, req.data);
};

AgentHandler.prototype.on_datamsg = function (req_id, req) {
  var self = this;

  if (!_.isArray(req.to) || !req.data) {
    return;
  }

  self.room.on_datamsg(self, req_id, req);
};

AgentHandler.prototype.on_webrtc = function (req_id, req) {
  if (!_.isArray(req.to) || !req.data) {
    return;
  }

  if (!req.action) {
    this.error(req_id, "Invalid WebRTC action.");
    return;
  }

  this.room.on_webrtc(this, req_id, req);
};

AgentHandler.prototype.on_create_term = function (req_id, req) {
  var self = this;
  self.room.create_term(self, req.term_name, req.size, req.id, function (err, result) {
    if (err) {
      return self.error(req_id, err);
    }
    log.log(self.toString(), "created terminal", result.toString());
  });
};

AgentHandler.prototype.on_delete_term = function (req_id, req) {
  var self = this;
  self.room.delete_term(self, req_id, req.id);
};

AgentHandler.prototype.on_saved = function (req_id, req) {
  var self = this;

  self.room.broadcast("saved", self, req_id, {
    id: req.id,
    user_id: self.id
  });
};

AgentHandler.prototype.get_term_or_error = function (term_id, owner_only, cb) {
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

AgentHandler.prototype.on_update_term = function (req_id, req) {
  var self = this;

  self.get_term_or_error(req.id, true, function (term) {
    term.update(self, req_id, req);
  });
};

AgentHandler.prototype.on_term_stdin = function (req_id, req) {
  var self = this;

  self.get_term_or_error(req.id, false, function (term) {
    term.stdin(self, req_id, req.data);
  });
};

AgentHandler.prototype.on_term_stdout = function (req_id, req) {
  var self = this;

  self.get_term_or_error(req.id, true, function (term) {
    term.stdout(req_id, req.data);
  });
};

AgentHandler.prototype.on_kick = function (req_id, req) {
  var self = this,
    agent;
  if (req === undefined || !_.isFinite(req.user_id)) {
    self.error(req_id, "You tried to kick someone, but you didn't specify the user_id.");
    return;
  }
  agent = self.room.handlers[req.user_id];
  if (agent) {
    if (agent.state < self.CONN_STATES.DISCONNECTING) {
      agent.disconnect(util.format("Kicked by %s", self.username));
    } else {
      agent.destroy();
    }
    self.ack(req_id);
  } else {
    self.error(req_id, util.format("User id %s doesn't exist.", req.user_id));
  }
};

AgentHandler.prototype.on_delete_temp_data = function (req_id, req) {
  var self = this;
  self.room.delete_temp_data(self, req_id, req.data);
};

AgentHandler.prototype.on_set_temp_data = function (req_id, req) {
  var self = this;
  if (!_.isObject(req.data)) {
    return self.error(req_id, "Invalid temp data.");
  }
  self.room.set_temp_data(self, req.data);
};

AgentHandler.prototype.on_pull_repo = function (req_id, req) {
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

AgentHandler.prototype.on_request_perms = function (req_id, req) {
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

AgentHandler.prototype.on_perms = function (req_id, req) {
  var self = this,
    action = req.action,
    fine_grained_perms = [],
    user,
    invalid_perms = [];

  user = self.room.handlers[req.user_id];
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

AgentHandler.prototype.on_solicit = function (req_id, req) {
  return this.room.solicit(this, req_id, req);
};