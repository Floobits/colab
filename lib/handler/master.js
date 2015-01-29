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
};

util.inherits(MasterHandler, BaseAgentHandler);

MasterHandler.prototype.auth = function(data) {
  utils.set_state(this, this.CONN_STATES.JOINED);
  clearTimeout(this.auth_timeout_id);
  log.log("\n", data);
  this.write("hi", null, {"asdf": 'asdf'});
};

MasterHandler.prototype.is_master = true;

module.exports = MasterHandler;