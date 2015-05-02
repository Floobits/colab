"use strict";

let util = require("util");

let log = require("floorine");

let BaseAgentHandler = require("./base");
let utils = require("../utils");


let VirtualAgent = function (slave_handler, opts) {
  // Sorta hacky. couples slave handler stuff :/
  BaseAgentHandler.call(this, slave_handler.protocol, slave_handler.auth_timeout_id);
  this.username = opts.username;
  this.room = opts.room;
  this.state = this.CONN_STATES.JOINED;
};

util.inherits(VirtualAgent, BaseAgentHandler);

VirtualAgent.prototype.name = "virtual floobits client";

VirtualAgent.prototype.disconnect = function (reason, cb) {
  // No-op
  log.log("Hah, not actually disconnecting");
  cb();
};

VirtualAgent.prototype.destroy = function () {
  utils.set_state(this, this.CONN_STATES.DESTROYED);
  this.protocol = null;
};

module.exports = VirtualAgent;
