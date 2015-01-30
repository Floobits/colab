/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");
var log = require("floorine");
var _ = require("lodash");

var FloobitsProtocol = require("./floobits");
var MasterHandler = require("../handler/master");


var MasterProtocol = function () {
  FloobitsProtocol.apply(this, arguments);
  this.install_handler(MasterHandler, this);
};

util.inherits(MasterProtocol, FloobitsProtocol);


module.exports = MasterProtocol;
