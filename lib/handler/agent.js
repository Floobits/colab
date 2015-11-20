"use strict";

const util = require("util");

const _ = require("lodash");
const async = require("async");
const log = require("floorine");

const actions = require("../actions");
const api_client = require("../api_client");
const BaseAgentHandler = require("./base");
const MSG = require("../msg");
const perms = require("../perms");
const Repo = require("../repo");
const utils = require("../utils");

const AgentHandler = function () {
  BaseAgentHandler.apply(this, arguments);
  this.room = null;
  this.is_anon = false;
  this.username = null;
  this.gravatar = null;
  this.color = null;
  this.can_contract = false;
  this.user_id = null;
  this.client = "";
  this.platform = null;
  this._patch_count = 0;
  this._patch_bytes = 0;
  this.bad_perm_requests = 0;
  this.request_perms_timeout = 0;
  this.last_highlight = {};
  this.video_chatting = false;
  this.can_contract = false;
  this.rate = 80;
  this.tags = [];
};

util.inherits(AgentHandler, BaseAgentHandler);

AgentHandler.prototype.name = "floobits client";

AgentHandler.prototype.toString = function () {
  return util.format("user %s conn_id %s client %s", this.username, this.id, this.client);
};

AgentHandler.prototype.to_json = function () {
  return {
    client: this.client,
    user_id: this.id,
    gravatar: this.gravatar,
    is_anon: this.is_anon,
    perms: this.perms,
    platform: this.platform,
    tags: this.tags,
    can_contract: this.can_contract,
    rate: this.rate,
    color: this.color,
    username: this.username,
    version: this.version,
    video_chatting: this.video_chatting,
  };
};

AgentHandler.prototype.destroy = function () {
  const self = this;
  if (self.room) {
    self.room.part(self);
    self.room = null;
  } else {
    log.warn("Agent %s had no room when destroying", self.toString());
  }

  AgentHandler.super_.prototype.destroy.call(self);
};

AgentHandler.prototype.auth = function (auth_data) {
  const self = this;
  let OK = true;
  let room_path = auth_data.path;

  if (!_.isString(auth_data.username) && !_.isString(auth_data.api_key)) {
    log.warn("Client didn't send username or api_key in auth data");
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
    return self.disconnect(util.format("Unsupported client version: %s. Please upgrade.", auth_data.version));
  }

  self.username = auth_data.username;
  self.api_key = auth_data.api_key;
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

  const auto = {
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
      self.tags = res.user.tags;
      self.color = res.user.color;
      self.user_id = res.user.id;
      self.gravatar = res.user.gravatar;
      self.can_contract = res.user.can_contract;
      self.rate = res.user.rate;
      log.log("Authenticated client %s user %s", self.toString(), self.username);
      actions.room.add_agent(room_path, self, res.user, cb);
    }],
    room_info: ["room", function (cb, res) {
      clearTimeout(self.auth_timeout_id);

      utils.set_state(self, self.CONN_STATES.JOINED);
      if (self.state > self.CONN_STATES.JOINED) {
        return cb(`Client in state ${self.CONN_STATES_REVERSE[self.state]}.`);
      }

      res.room.handlers[self.id] = self;
      self.room = res.room;

      log.debug("client %s authenticated and joined room %s", self.toString(), self.room.name);

      let room_info = self.room.room_info();
      // add_agent munges agent.perms as a side-effect :/
      room_info.perms = self.perms;
      room_info.user_id = self.id;
      // Brilliant
      room_info.motd = self.room.server.motd;
      // Start idle ping
      self.ping();
      self.room.broadcast("join", self, null, self.to_json());
      return self.write("room_info", auth_data.req_id, room_info, cb);
    }],
    replay_events: ["room_info", function (cb) {
      self.room.replay_events(self, cb);
    }],
    replay_solicitations: ["room_info", function (cb, res) {
      res.room.replay_solicitations(self, cb);
    }],
  };

  return self.safe_auto(auto, function (err) {
    clearTimeout(self.auth_timeout_id);
    if (err) {
      log.warn("Error adding agent %s: %s", self.toString(), err);
      return self.disconnect(err);
    }
  });
};

AgentHandler.prototype._conn_guard = function (f) {
  const self = this;

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
  const self = this;

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

AgentHandler.prototype.on_patch = function (req_id, req) {
  const self = this;
  const buf = self.room.get_buf(req.id);
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
  const self = this;
  const buf = self.room.get_buf(req.id);
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
  const self = this;
  const buf = self.room.get_buf(req.id);
  if (!buf) {
    self.error(req_id, util.format("Buffer with id %s doesn't exist", req.id));
    return;
  }
  buf.send_get_buf(self, req_id, 0);
};

AgentHandler.prototype.on_create_buf = function (req_id, req) {
  const self = this;
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
  const self = this;
  self.room.delete_buf(self, req_id, req.id, req.unlink, function (err) {
    if (err) {
      self.error(req_id, util.format("Error deleting buffer %s: %s", req.id, err));
    }
  });
};

AgentHandler.prototype.on_rename_buf = function (req_id, req) {
  const self = this;
  self.room.rename_buf(self, req_id, req.id, req.path, function (err) {
    if (err) {
      log.error("error renaming buf:", err);
      self.error(req_id, util.format("Error renaming buffer %s to %s: %s", req.id, req.path, err), true);
    }
  });
};

AgentHandler.prototype.on_highlight = function (req_id, req) {
  const self = this;

  if (_.isEqual(req, self.last_highlight)) {
    log.debug("agent %s sent the same highlight as before", self.toString());
    self.ack(req_id);
    return;
  }

  self.room.on_highlight(self, req_id, req, function (err) {
    if (err) {
      self.error(req_id, err);
    } else {
      self.last_highlight = req;
    }
  });
};

AgentHandler.prototype.on_msg = function (req_id, req) {
  const self = this;
  if (!req.to) {
    self.room.on_msg(self, req_id, req.data);
    return;
  }
  let msg = new MSG(self, req.data).to_json();
  msg.name = req.name;
  actions.broadcast.send_to_user(self.username, req.to, msg, function (err) {
    if (err) {
      self.error(req_id, err);
    } else {
      self.ack(req_id);
    }
  });
};

AgentHandler.prototype.on_datamsg = function (req_id, req) {
  if (!_.isArray(req.to) || !req.data) {
    log.debug("Bad datamsg from %s. No to or data.", this.toString());
    return;
  }
  this.room.on_datamsg(this, req_id, req);
};

AgentHandler.prototype.on_webrtc = function (req_id, req) {
  if (!_.isArray(req.to) || !req.data) {
    log.debug("Bad webrtc msg from %s. No to or data.", this.toString());
    return;
  }

  if (!req.action) {
    this.error(req_id, "Invalid WebRTC action.");
    return;
  }
  this.room.on_webrtc(this, req_id, req);
};

AgentHandler.prototype.on_create_term = function (req_id, req) {
  const self = this;
  self.room.create_term(self, req.term_name, req.size, req.id, function (err, result) {
    if (err) {
      return self.error(req_id, err);
    }
    log.log(self.toString(), "created terminal", result.toString());
    self.ack(req_id);
  });
};

AgentHandler.prototype.on_delete_term = function (req_id, req) {
  const self = this;
  self.room.delete_term(self, req_id, req.id);
};

AgentHandler.prototype.on_saved = function (req_id, req) {
  const self = this;

  // TODO: delay save events slightly? many plugins
  self.room.broadcast("saved", self, req_id, {
    id: req.id,
    user_id: self.id
  });
};

AgentHandler.prototype.get_term_or_error = function (term_id, owner_only, cb) {
  const self = this;

  const term = self.room.get_term(term_id);
  if (!term) {
    return self.error(null, util.format("Terminal %s doesn't exist", term_id));
  }
  if (owner_only && self.id !== term.owner.id) {
    return self.error(null, util.format("Only the terminal owner can perform this action."));
  }
  return cb(term);
};

AgentHandler.prototype.on_update_term = function (req_id, req) {
  const self = this;
  self.get_term_or_error(req.id, true, function (term) {
    term.update(self, req_id, req);
  });
};

AgentHandler.prototype.on_term_stdin = function (req_id, req) {
  const self = this;

  self.get_term_or_error(req.id, false, function (term) {
    term.stdin(self, req_id, req.data);
  });
};

AgentHandler.prototype.on_term_stdout = function (req_id, req) {
  const self = this;

  self.get_term_or_error(req.id, true, function (term) {
    term.stdout(req_id, req.data);
  });
};

AgentHandler.prototype.on_kick = function (req_id, req) {
  const self = this;
  if (req === undefined || !_.isFinite(req.user_id)) {
    self.error(req_id, "You tried to kick someone, but you didn't specify the user_id.");
    return;
  }
  const agent = self.room.handlers[req.user_id];
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
  const self = this;
  self.room.delete_temp_data(self, req_id, req.data);
};

AgentHandler.prototype.on_set_temp_data = function (req_id, req) {
  const self = this;
  if (!_.isObject(req.data)) {
    return self.error(req_id, "Invalid temp data.");
  }
  self.room.set_temp_data(self, req.data);
};

AgentHandler.prototype.on_pull_repo = function (req_id, req) {
  const self = this;
  function cb(err) {
    let room = self.room || "(no workspace)";
    if (err) {
      log.error("%s error updating repo for %s: %s", self.toString(), room.toString(), err);
      return self && self.error(req_id, err, true);
    }
    log.log("%s updated repo for %s", self.toString(), room.toString());
    if (room.save) {
      room.save();
    } else {
      log.warn("Can't save workspace after pull_repo. Must have been purged already.");
    }
    // Super-lame, but self can sometimes be null/undefined at this point
    return self && self.ack(req_id);
  }

  if (self.room.repo && self.room.repo.is_equal(req)) {
    self.room.repo.update(self, req_id, cb);
  } else {
    try {
      self.room.repo = new Repo(self.room, req, self.room.repo && self.room.repo.private_github_url);
    } catch (e) {
      self.error(req_id, "Error creating repository:" + e.toString(), true);
      return;
    }
    self.room.repo.clone(self, req_id, cb);
  }
};

AgentHandler.prototype.on_request_perms = function (req_id, req) {
  const self = this;
  const admins = self.room.get_admins();
  if (_.isEmpty(admins)) {
    return self.error(req_id, "Permission request failed: There are no admins in this workspace.", true);
  }

  const now = Date.now();
  if (self.request_perms_timeout > now) {
    return self.error(req_id, util.format("You can not make another request for %s seconds.", (self.request_perms_timeout - now) / 1000));
  }

  self.bad_perm_requests += 1;
  const timeout = Math.min(Math.pow(2, self.bad_perm_requests), 60 * 60);
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
  const self = this;
  const action = req.action;
  let fine_grained_perms = [];
  let invalid_perms = [];

  const user = self.room.handlers[req.user_id];
  if (_.isUndefined(user)) {
    return self.error(req_id, "User doesn't exist.");
  }

  if (action === "reject") {
    return user.error(req_id, util.format("Your request for %s permission was rejected by %s", req.perms, self.username), true);
  }

  _.each(req.perms, function (perm) {
    const perms_list = perms.db_perms_mapping[perm];
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

  api_client.perms_for_room((user.is_anon ? "AnonymousUser" : user.username), self.room.id, false, function (err, perms_list) {
    if (err) {
      log.error(err);
      return;
    }

    // Django response is lame
    perms_list = perms_list.perms;

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

    if (user.is_anon) {
      return;
    }

    api_client.perms_set(user.username, self.room.id, perms_list, function (perms_set_err, updated_perms) {
      if (perms_set_err) {
        log.error("NOOO we couldn't set perms", updated_perms, "for user", user.username, ":", perms_set_err);
        return;
      }
      log.log("Hooray. We set perms:", updated_perms, user.username);
    });
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
  const self = this;
  return self.room.solicit(self, req_id, req, function (err, result) {
    if (err) {
      self.error(req_id, err);
      return;
    }
    if (result) {
      self.write("solicit", req_id, result);
      return;
    }
    self.ack(req_id);
  });
};

module.exports = AgentHandler;
