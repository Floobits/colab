"use strict";

const util = require("util");

const log = require("floorine");

const BaseAgentHandler = require("./base");
const utils = require("../utils");
const perms = require("../perms");


const VirtualAgent = function (opts) {
  // Sorta hacky. couples handler stuff :/
  this.id = -1;
  this.perms = perms.all_perms;
  this.room = opts.room;
  this.state = this.CONN_STATES.JOINED;
  this.username = opts.username;
  log.warn("Created virtual agent %s", this.toString());
};

util.inherits(VirtualAgent, BaseAgentHandler);

VirtualAgent.prototype.name = "virtual floobits client";

VirtualAgent.prototype.toString = function () {
  return util.format("virtual %s/%s - %s", this.room.owner, this.room.name, this.username);
};

VirtualAgent.prototype.write = function (name, res_id, json, cb) {
  return cb && cb();
};

VirtualAgent.prototype.request = function (name, json, cb) {
  return cb && cb();
};

// VirtualAgent.prototype.handle = function () {
// };

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
