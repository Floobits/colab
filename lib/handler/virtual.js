"use strict";

const util = require("util");

const log = require("floorine");

const BaseAgentHandler = require("./base");
const utils = require("../utils");
const perms = require("../perms");


const VirtualAgent = function (slave_handler, opts) {
  // Sorta hacky. couples slave handler stuff :/
  BaseAgentHandler.call(this, slave_handler.protocol, slave_handler.auth_timeout_id);
  this.perms = perms.all_perms;
  this.room = opts.room;
  this.state = this.CONN_STATES.JOINED;
  this.username = opts.username;
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
  this.perms = [];
  this.protocol = null;
  this.room = null;
};

module.exports = VirtualAgent;
