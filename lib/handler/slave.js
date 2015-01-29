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

var SlaveHandler = function () {
  BaseAgentHandler.apply(this, arguments);
  this.perms = ["slave", "hi", "ping", "pong"];
};

util.inherits(SlaveHandler, BaseAgentHandler);

SlaveHandler.prototype.auth = function () {
  utils.set_state(this, this.CONN_STATES.JOINED);
  clearTimeout(this.auth_timeout_id);
  this.write("slave", null, {data: "hello"});
  clearTimeout(this.auth_timeout_id);
};

SlaveHandler.prototype.on_hi = function(data) {
};

module.exports = SlaveHandler;
