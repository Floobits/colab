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
};

util.inherits(SlaveHandler, BaseAgentHandler);

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

  utils.set_state(self, self.CONN_STATES.JOINED);

  actions.colab.add(self);
  self.master.colabs[colab_id] = new colab.Colab(self.master, {
    id: colab_id,
  });
  // self.write("hi", null, {"asdf": 'asdf'});
};

SlaveHandler.prototype.on_workspaces = function (req_id, data) {
  var self = this;

  self.colab.update_workspace_counts(data.workspaces);
  return self.ack(req_id);
};

SlaveHandler.prototype.on_load = function (req_id, data) {
  var self = this;

  self.colab.update_load(data.load);
  return self.ack(req_id);
};

SlaveHandler.prototype.is_master = true;

module.exports = SlaveHandler;
