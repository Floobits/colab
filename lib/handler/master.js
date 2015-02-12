/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");
var tls = require("tls");

var async = require("async");
var fs = require("fs-extra");
var log = require("floorine");
var _ = require("lodash");

var actions = require("../actions");
var ldb = require("../ldb");
var BaseAgentHandler = require("./base");
var settings = require('../settings');
var slave = require("../slave/slave");
var utils = require("../utils");


var MasterHandler = function (protocol, auth_timeout_id) {
  var self = this;

  BaseAgentHandler.call(self, protocol, auth_timeout_id);

  self.proto_version = 0.11;
  self.server = null;
  self.perms = [
    "broadcast",
    "colab_auth",
    "disconnect",
    "error",
    "load",
    "ping",
    "pong",
    "wallops",
    "workspaces",
    "workspace",
  ];
  self.stats_timeout = null;
};

util.inherits(MasterHandler, BaseAgentHandler);

MasterHandler.prototype.name = "my master";

MasterHandler.prototype.auth = function (server) {
  var self = this;

  self.server = server;
  self.db = server.db;
  utils.set_state(this, this.CONN_STATES.JOINED);
  clearTimeout(this.auth_timeout_id);

  self.request("colab_auth", {
    username: settings.auth.username,
    password: settings.auth.password,
    colab_id: self.server.id,
    version: self.proto_version,
    backup: !!settings.backup,
    exclude: !!settings.exclude,
    colab_port: settings.json_port_ssl,
    api_port: settings.api_port,
  });

  this.send_stats();
};

MasterHandler.prototype.cleanup = function () {
  MasterHandler.super_.prototype.cleanup.call(this);
  this.server = null;
  this.stats_timeout = clearTimeout(this.stats_timeout);
};

MasterHandler.prototype.send_stats = function () {
  var self = this;

  async.parallel([
    self.send_workspaces.bind(self),
    self.send_load.bind(self),
  ], function (err) {
    if (err) {
      log.error(err);
    }
    self.stats_timeout = setTimeout(self.send_stats.bind(self), 10000);
  });
};

MasterHandler.prototype.send_workspaces = function (cb) {
  var self = this;

  slave.all_workspaces(self.server, function (err, workspaces) {
    if (err) {
      log.error("Error building workspace list!", err);
      return;
    }
    self.request("workspaces", { workspaces: workspaces }, cb);
  });
};

MasterHandler.prototype.send_load = function (cb) {
  var self = this;

  slave.get_load(function (err, load) {
    if (err) {
      log.error("Error getting load info!", err);
      return;
    }
    self.request("load", { data: load }, cb);
  });
};

MasterHandler.prototype.on_workspace = function (req_id, data) {
  var self = this,
    cb,
    action = data.action,
    workspace_id = data.id;

  if (!workspace_id || !_.isFinite(workspace_id)) {
    self.error(req_id, "No workspace ID or bad ID");
    return;
  }

  if (!action) {
    self.error(req_id, util.format("No action for workspace %s.", workspace_id));
    return;
  }

  data = data.data;

  cb = function (err, result) {
    if (err) {
      self.error(req_id, err.toString(), false);
    } else {
      self.write("workspace", req_id, {
        action: action,
        workspace: result,
      });
    }
  };

  switch (action) {
  case "create":
    slave.create_workspace(self.server, workspace_id, data.version);
    break;
  case "fetch":
    // lame hack to work around express ipv6 bug
    if (data.ip_proto === "IPv6") {
      data.ip = util.format("[%s]", data.ip);
    }
    slave.fetch_workspace(self.server, workspace_id, data.proto, data.ip, data.port, cb);
    break;
  default:
    self.error(req_id, util.format("Unknown action for workspace %s.", workspace_id));
  }
};

MasterHandler.prototype.broadcast = function (type, data, cb) {
  this.request("broadcast", {
    type: type,
    data: data,
  }, cb);
};

MasterHandler.prototype.on_broadcast = function (req_id, data) {
  switch (data.type) {
  case "send_to_user":
    actions.broadcast.send_to_user(data.data);
    break;
  case "solicit":
    actions.broadcast.solicit(data.data);
    break;
  default:
    log.error("unsupported broadcast", data);
    this.error(req_id, "unsupported broadcast", false);
    return;
  }
  this.ack(req_id);
};

MasterHandler.prototype.on_disconnect = function (req_id, data) {
  log.error("disconnected from master because %s.", data.reason);
  this.ack(req_id);
  this.destroy();
};

MasterHandler.prototype.on_wallops = function (req_id, data) {
  var self = this;
  self.server.wallops(data.data);
  self.ack(req_id);
};

MasterHandler.prototype.on_motd = function (req_id, data) {
  this.server.motd = data.data;
  this.ack(req_id);
};

module.exports = MasterHandler;
