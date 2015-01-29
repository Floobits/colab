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

var SlaveHandler = function (protocol, auth_timeout_id, server) {
  BaseAgentHandler.call(this, protocol, auth_timeout_id);
  this.server = server;
  this.perms = [
    "ping",
    "pong",
    "colab_auth",
    "disconnect",
    "workspaces",
    "load",
  ];
};

util.inherits(SlaveHandler, BaseAgentHandler);

SlaveHandler.prototype.handle = function (msg) {
  var self = this, req_id, f_name, f;

  f_name = "on_" + msg.name;
  try {
    log.debug("Calling %s", f_name);
    f = self[f_name];
    if (_.isFunction(f)) {
      self.ping();
      f.call(this, req_id, msg);
    } else {
      log.error("%s No function %s msg %s", self.toString(), f_name, msg);
      self.error(req_id, util.format("Unknown action: %s", msg.name), false);
      return self.disconnect();
    }
  } catch (e) {
    log.error("%s calling %s msg %s", self.toString(), f_name, msg, e);
    return self.disconnect();
  }
};

SlaveHandler.prototype.auth = function () {
  var self = this;
  utils.set_state(this, this.CONN_STATES.JOINED);
  clearTimeout(this.auth_timeout_id);
  self.write("colab_auth", null, {
    username: settings.auth.username,
    password: settings.auth.password,
    colab_id: self.server.id,
  });
  slave.all_workspaces(this.server, function (err, workspaces) {
    self.write("workspaces", null, {workspaces: workspaces});
  });
  slave.get_load(function (err, load) {
    self.write("load", null, {data: load});
  });
};

SlaveHandler.prototype.on_hi = function (data) {
};

module.exports = SlaveHandler;
