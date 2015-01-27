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


var BaseAgentHandler = function () {
  var self = this;
  self.client = "";
  self.platform = null;
  self.version = null;
  self.room = null;
  self.is_anon = false;
  self.username = null;
  self.gravatar = null;
  self.user_id = null;

  self.last_highlight = {};
  self.metrics_interval = null;

  self._joined_at = null;
  self._patch_count = 0;
  self._patch_bytes = 0;

  self.bad_perm_requests = 0;
  self.request_perms_timeout = 0;
};

util.inherits(BaseAgentHandler, events.EventEmitter);

BaseAgentHandler.prototype._conn_guard = function (f) {
  var self = this;
  function inner(cb) {
    // Return early if agent is disconnected
    if (self.state >= CONN_STATES.DISCONNECTING) {
      return cb(util.format("Agent is %s", CONN_STATES_REVERSE[self.state]));
    }
    return f.apply(self, arguments);
  }
  return inner;
};

BaseAgentHandler.prototype.safe_auto = function (auto, cb) {
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

BaseAgentHandler.prototype.auth = function (auth_data, cb) {
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
      self.gravatar = res.user.gravatar;
      log.log("Authenticated client %s user %s", self.toString(), self.username);
      Room.add_agent(room_path, self, res.user, cb);
    }]
  };

  return self.safe_auto(auto, function (err, result) {
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

module.exports = AgentHandler;