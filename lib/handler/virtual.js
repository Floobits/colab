"use strict";

let util = require("util");

let log = require("floorine");

let BaseAgentHandler = require("./base");


let VirtualAgent = function (slave_handler, opts) {
  // Sorta hacky. couples slave handler stuff :/
  BaseAgentHandler.call(this, slave_handler.protocol, slave_handler.auth_timeout_id);
  this.username = opts.username;
};

util.inherits(VirtualAgent, BaseAgentHandler);

VirtualAgent.prototype.disconnect = function () {
  // No-op
  log.log("Hah, not actually disconnecting");
  return;
};

VirtualAgent.prototype.destroy = function () {
  log.log("Hah, not actually disconnecting");
  return;
};

module.exports = VirtualAgent;
