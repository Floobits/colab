/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var BaseAgentHandler = require("./base");
var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var settings = require("../settings");
var utils = require("../utils");
var actions = require("../actions");


var AUTHED_PERMS = [
  "ack",
  "create_workspace",
  "disconnect",
  "error",
  "load",
  "ping",
  "pong",
  "workspaces",
];

var SlaveHandler = function () {
  var self = this;

  BaseAgentHandler.apply(self, arguments);

  // Initial perms. They'll get more if they auth.
  self.perms = ["colab_auth"];

  self.exclude = null;
  self.backup = null;
  // TODO: actually set this based on whether we're using SSL
  self.ssl = true;

  self.errors = 0;
  self.id = "";
  self.colab_port = null;
  self.ip = "";
  self.load = {
    memory: {},
    loadavg: null,
    cpus: null,
    disk: {},
    uptime: {}
  };

  self.workspaces = {};
  self.active_workspaces = [];

  self.heartbeat_idle_period = 5000;
  self.disconnect_timeout = 15000;
};

util.inherits(SlaveHandler, BaseAgentHandler);

SlaveHandler.prototype.name = "slave";
SlaveHandler.prototype.is_slave = true;

SlaveHandler.prototype.to_json = function () {
  var self = this;
  return _.filter(self, function (v, k) {
    return _.contains(["id", "exclude", "backup", "active_workspaces", "load"], k);
  });
};

SlaveHandler.prototype.toString = function () {
  return this.id;
};

SlaveHandler.prototype.on_colab_auth = function (req_id, data) {
  var self = this,
    colab_id = data.colab_id;

  clearTimeout(self.auth_timeout_id);

  if (!colab_id) {
    self.disconnect("No colab id in auth!");
    return;
  }

  if (!data.colab_port || !data.api_port) {
    self.disconnect("Missing port info!");
    return;
  }

  if (data.username !== settings.auth.username || data.password !== settings.auth.password) {
    self.disconnect("Invalid auth.");
    return;
  }

  self.ip = self.protocol.remote_address;
  self.perms = AUTHED_PERMS;
  self.id = colab_id;
  self.colab_port = data.colab_port;
  self.api_port = data.api_port;
  self.exclude = !!data.exclude;
  self.backup = !!data.backup;
  // Exclude backup servers from repcounts and whatnot.
  if (self.backup) {
    self.exclude = true;
  }

  utils.set_state(self, self.CONN_STATES.JOINED);

  actions.slave.add(self.id, self);
  self.ack(req_id);
  self.on_pong();
};

SlaveHandler.prototype.on_workspaces = function (req_id, data) {
  var self = this;

  self.workspaces = data.workspaces;
  actions.slave.update_count(self.id, data.workspaces);
  return self.ack(req_id);
};

SlaveHandler.prototype.on_load = function (req_id, data) {
  var self = this;

  self.load = data.data;
  return self.ack(req_id);
};

SlaveHandler.prototype.create_workspace = function (id, version, cb) {
  var self = this;

  self.request("create_workspace", {id: id, version: version || 0}, function (err, data) {
    if (data.name === "create_workspace") {
      self.on_create_workspace(data.req_id, data);
    }
    return cb(err, data.workspace);
  });
};

SlaveHandler.prototype.on_create_workspace = function (req_id, data) {
  var self = this,
    workspace = data.workspace;

  if (!_.isObject(workspace)) {
    self.error(req_id, "Invalid create_workspace.");
    return;
  }

  self.workspaces[workspace.id] = workspace;
  actions.slave.create_workspace(self.id, workspace);

  if (req_id) {
    self.ack(req_id);
  }
};

module.exports = SlaveHandler;
