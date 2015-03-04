/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var log = require("floorine");
var _ = require("lodash");

var AgentHandler = require("./agent");
var utils = require("../utils");
var actions = require("../actions");
var settings = require("../settings");


var ReplicationClientHandler = function () {
  AgentHandler.apply(this, arguments);
};

util.inherits(ReplicationClientHandler, AgentHandler);

ReplicationClientHandler.prototype.name = "repclient";

ReplicationClientHandler.prototype.toString = function () {
  var self = this;
  return util.format("colab %s conn_id %s", self.colab_id, self.id);
};

ReplicationClientHandler.prototype.to_json = function () {
  var self = this;
  return {
    client: self.client,
    user_id: self.id,
    perms: self.perms,
    version: self.version
  };
};

ReplicationClientHandler.prototype.auth = function (auth_data) {
  var self = this,
    workspace_id = auth_data.workspace_id,
    OK = true;

  if (!_.isString(auth_data.api_key) || !_.isString(auth_data.secret)) {
    log.warn("Replication client didn't send username or api_key in auth data");
    OK = false;
  }
  _.each(["secret", "version"], function (key) {
    if (!_.has(auth_data, key)) {
      log.warn("Client didn't send %s in auth data", key);
      OK = false;
    }
  });

  if (!_.isFinite(workspace_id)) {
    log.warn("Client %s didn't send workspace id", self.toString());
    OK = false;
  }

  if (!OK) {
    return self.disconnect("Bad auth JSON");
  }
  auth_data.version = Number(auth_data.version);
  if (!_.contains(self.SUPPORTED_VERSIONS, auth_data.version)) {
    return self.disconnect(util.format("Unsupported client version: %s; disconnecting client.", auth_data.version));
  }

  if (auth_data.api_key !== settings.auth.username || auth_data.secret !== settings.auth.password) {
    return self.disconnect("Bad credentials.");
  }

  self.api_key = auth_data.api_key;
  self.secret = auth_data.secret;
  self.client = auth_data.client || "";
  self.client = self.client.slice(0, 30);
  self.version = auth_data.version;
  self.platform = auth_data.platform;
  self.colab_id = auth_data.colab_id;

  self.handle_forwarded_options(auth_data);

  self.supported_encodings = auth_data.supported_encodings;

  return actions.room.add_colab(workspace_id, self, function (err, room) {
    clearTimeout(self.auth_timeout_id);

    if (err || !room) {
      log.warn("Error adding agent %s: %s", self.toString(), err);
      return self.disconnect(err);
    }

    utils.set_state(self, self.CONN_STATES.JOINED);
    if (self.state > self.CONN_STATES.JOINED) {
      log.log("client %s is in state %s. Disconnecting.", self.toString(), self.state);
      return self.disconnect();
    }

    room.handlers[self.id] = self;
    self.room = room;

    log.debug("%s authenticated and joined room %s", self.toString(), self.room.name);

    let room_info = self.room.to_json();
    // add_agent munges agent.perms as a side-effect :/
    room_info.perms = self.perms;
    room_info.user_id = self.id;
    // Brilliant
    room_info.motd = self.room.server.motd;
    // Replication needs this
    room_info.version = self.room.version;
    room_info.events = self.room.events;

    self.write("room_info", auth_data.req_id, room_info);
    self.on_pong();
  });
};

module.exports = ReplicationClientHandler;
