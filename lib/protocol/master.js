"use strict";

const util = require("util");

const FloobitsProtocol = require("./floobits");
const MasterHandler = require("../handler/master");


const MasterProtocol = function () {
  FloobitsProtocol.apply(this, arguments);
};

util.inherits(MasterProtocol, FloobitsProtocol);

MasterProtocol.prototype.init_conn = function () {
  const self = this;
  MasterProtocol.super_.prototype.init_conn.apply(self, arguments);
  self.install_handler(MasterHandler, self);
};

module.exports = MasterProtocol;
