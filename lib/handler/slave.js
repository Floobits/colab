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
  "broadcast",
  "disconnect",
  "error",
  "load",
  "motd",
  "ping",
  "pong",
  "workspace",
  "workspaces",
];

var SlaveHandler = function () {
  var self = this;

  BaseAgentHandler.apply(self, arguments);

  // Initial perms. They'll get more if they auth.
  self.perms = ["colab_auth"];

  // Exclude is set to its real value on workspaces
  self.exclude = true;
  self.backup = null;
  // TODO: actually set this based on whether we're using SSL
  self.ssl = true;

  // Time at which we were last disconnected
  self.disconnected = 0;
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
  return {
    id: self.id,
    ip: self.ip,
    colab_port: self.colab_port,
    backup: self.backup,
    exclude: self.exclude,
    load: self.load,
    active_workspaces: self.active_workspaces,
  };
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
  self.ip_proto = self.protocol.remote_family;
  self.perms = AUTHED_PERMS;
  self.id = colab_id;
  self.colab_port = data.colab_port;
  self.api_port = data.api_port;
  self._exclude = !!data.exclude;
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

  self.exclude = self._exclude;
  self.workspaces = data.workspaces;
  self.active_workspaces = _.filter(self.workspaces, function (w) {
    return !!w.active;
  });
  actions.slave.update_count(self.id, data.workspaces);
  return self.ack(req_id);
};

SlaveHandler.prototype.on_load = function (req_id, data) {
  var self = this;

  self.load = data.data;
  return self.ack(req_id);
};

SlaveHandler.prototype.workspace = function (id, action, data, cb) {
  var self = this;
  self.request("workspace", {
    id: id,
    action: action,
    data: data,
  }, cb);
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

SlaveHandler.prototype.on_workspace = function (req_id, data) {
  var self = this,
    workspace = data.workspace;

  if (!_.isObject(workspace)) {
    self.error(req_id, "Invalid workspace.");
    return;
  }

  if (data.action === "create") {
    self.workspaces[workspace.id] = workspace;
    actions.slave.create_workspace(self.id, workspace);
  }

  if (req_id) {
    self.ack(req_id);
  }
};

SlaveHandler.prototype.broadcast = function (data, cb) {
  var self = this;
  self.request("broadcast", data, cb);
};

SlaveHandler.prototype.on_broadcast = function (req_id, data) {
  var self = this;

  actions.broadcast.send_to_slaves(data, function (err) {
    if (err) {
      // TODO? something else here?
      self.error(req_id, err);
      return;
    }
    self.ack(req_id);
  });
};

SlaveHandler.prototype.on_error = function (req_id) {
  this.ack(req_id);
};

SlaveHandler.prototype.wallops = function (wallops, cb) {
  var self = this;
  self.request("wallops", {data: wallops}, cb);
};

SlaveHandler.prototype.motd = function (motd, cb) {
  var self = this;
  self.request("motd", {data: motd}, cb);
};

module.exports = SlaveHandler;
