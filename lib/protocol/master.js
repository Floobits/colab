/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var tls = require("tls");
var util = require("util");

var log = require("floorine");
var _ = require("lodash");

var actions = require("../actions");
var FloobitsProtocol = require("./floobits");
var MasterHandler = require("../handler/master");


var MasterProtocol = function () {
  FloobitsProtocol.apply(this, arguments);
};

util.inherits(MasterProtocol, FloobitsProtocol);

MasterProtocol.prototype.init_conn = function () {
  var self = this;

  MasterProtocol.super_.prototype.init_conn.apply(self, arguments);
  self.install_handler(MasterHandler, self);
};

module.exports = MasterProtocol;
