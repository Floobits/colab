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

var SlaveHandler = function () {
  var self = this;

  BaseAgentHandler.apply(self, arguments);

  // Initial perms. They'll get more if they auth.
  self.perms = ["colab_auth"];
  self.exclude = null;
  self.backup = null;
  self.id = null;
  self.load = {
    memory: {},
    loadavg: null,
    cpus: null,
    disk: {},
    uptime: {}
  };

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

  if (data.username !== settings.auth.username || data.password !== settings.auth.password) {
    self.disconnect("Invalid auth.");
    return;
  }

  self.perms = ["ping", "pong", "disconnect", "workspaces", "load"];
  self.id = colab_id;
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

  self.load = data.load;
  actions.slave.update_load(self.id, data.load);
  return self.ack(req_id);
};

module.exports = SlaveHandler;
