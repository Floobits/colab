/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");
var tls = require("tls");

var BaseAgentHandler = require("./base");
var async = require("async");
var log = require("floorine");
var _ = require("lodash");


function SlaveHandler () {
  BaseAgentHandler.call(this, arguments);
}

util.inherits(SlaveHandler, BaseAgentHandler);

SlaveHandler.prototype.connect = function() {
  tls.connect(port, [host], [options], [callback])
};
