/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");
var tls = require("tls");

var BaseAgentHandler = require("./base");
var async = require("async");
var log = require("floorine");
var _ = require("lodash");
var settings = require('../settings');
var utils = require("../utils");

var MasterHandler = function () {
  BaseAgentHandler.apply(this, arguments);
  this.perms = ['hi', "ping", "pong", "disconnect", "workspaces", "load"];
};

util.inherits(MasterHandler, BaseAgentHandler);

MasterHandler.prototype.auth = function (data) {
  clearTimeout(this.auth_timeout_id);

  if (!data.colab_id) {
    this.disconnect("No colab id in auth!");
    return;
  }

  if (data.username !== settings.auth.username || data.password !== settings.auth.password) {
    this.disconnect("Invalid auth.");
    return;
  }

  utils.set_state(this, this.CONN_STATES.JOINED);
  log.log("\n", data);
  this.write("hi", null, {"asdf": 'asdf'});
};

MasterHandler.prototype.on_workspaces = function (req_id, data) {
  log.log(data);
};

MasterHandler.prototype.on_load = function (req_id, data) {
  log.log(data);
};

MasterHandler.prototype.is_master = true;

module.exports = MasterHandler;
