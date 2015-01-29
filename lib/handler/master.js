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

var MasterHandler = function (protocol, auth_timeout_id, server) {
  var self = this;

  BaseAgentHandler.call(self, protocol, auth_timeout_id);

  self.proto_version = 0.11;
  self.server = server;
  self.perms = [
    "ping",
    "pong",
    "colab_auth",
    "disconnect",
    "workspaces",
    "load",
  ];
};

util.inherits(MasterHandler, BaseAgentHandler);


MasterHandler.prototype.auth = function () {
  var self = this;
  utils.set_state(this, this.CONN_STATES.JOINED);
  clearTimeout(this.auth_timeout_id);
  self.write("colab_auth", null, {
    username: settings.auth.username,
    password: settings.auth.password,
    colab_id: self.server.id,
    version: self.proto_version,
  });
  slave.all_workspaces(this.server, function (err, workspaces) {
    if (err) {
      log.error("Error building workspace list!", err);
      return;
    }
    self.write("workspaces", null, {workspaces: workspaces});
  });
  slave.get_load(function (err, load) {
    if (err) {
      log.error("Error getting load info!", err);
      return;
    }
    self.write("load", null, {data: load});
  });
};

module.exports = MasterHandler;
