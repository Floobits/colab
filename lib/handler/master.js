/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");
var tls = require("tls");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

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
    "ping",
    "pong",
    "colab_auth",
    "disconnect",
    "workspaces",
    "load",
    "ack",
    "error",
  ];
  self.stats_timeout = null;
};

util.inherits(MasterHandler, BaseAgentHandler);

MasterHandler.prototype.name = "my master";

MasterHandler.prototype.write = function (name, res_id, json, cb) {
  var self = this;

  if (self.state < self.CONN_STATES.JOINED) {
    log.warn("client %s: Discarding event %s because conn state is %s", self.toString(), name, self.state);
    return cb && cb();
  }
  if (self.state >= self.CONN_STATES.DESTROYED) {
    log.error("Somebody called write after we destroyed connection %s!", self.id);
    log.error("Event: %s", name);
    console.trace();
    return cb && cb();
  }
  json.name = name;
  self.protocol.request(json, cb);
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
    self.stats_timeout = setTimeout(self.send_stats.bind(self), 30000);
  });
};

MasterHandler.prototype.send_workspaces = function (cb) {
  var self = this;

  slave.all_workspaces(self.server, function (err, workspaces) {
    if (err) {
      log.error("Error building workspace list!", err);
      return;
    }
    self.write("workspaces", null, { workspaces: workspaces }, cb);
  });
};

MasterHandler.prototype.send_load = function (cb) {
  var self = this;

  slave.get_load(function (err, load) {
    if (err) {
      log.error("Error getting load info!", err);
      return;
    }
    self.write("load", null, { data: load }, cb);
  });
};

MasterHandler.prototype.auth = function (server) {
  var self = this;

  self.server = server;
  utils.set_state(this, this.CONN_STATES.JOINED);
  clearTimeout(this.auth_timeout_id);

  self.write("colab_auth", null, {
    username: settings.auth.username,
    password: settings.auth.password,
    colab_id: self.server.id,
    version: self.proto_version,
    backup: !!settings.backup,
    exclude: !!settings.exclude,
  });

  this.send_stats();
};

module.exports = MasterHandler;
