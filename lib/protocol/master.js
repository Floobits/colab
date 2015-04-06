"use strict";

var util = require("util");

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
