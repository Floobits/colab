/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");
var tls = require("tls");

var BaseAgentHandler = require("./base");
var async = require("async");
var log = require("floorine");
var _ = require("lodash");
var settings = require('../settings');

var SlaveHandler = function () {
  BaseAgentHandler.apply(this, arguments);
};

util.inherits(SlaveHandler, BaseAgentHandler);

module.exports = SlaveHandler;
