"use strict";

const events = require("events");
const util = require("util");

const log = require("floorine");
const _ = require("lodash");

const utils = require("../utils");

const CONN_STATES = {
  AUTH_WAIT: 1,
  JOINED: 2,
  DISCONNECTING: 3,
  DESTROYED: 4
};

const CONN_STATES_REVERSE = _.invert(CONN_STATES);

// 1.0 is name & action for every event
const SUPPORTED_VERSIONS = [0.11, 1.0];

const BaseAgentHandler = function (protocol, auth_timeout_id) {
  this.id = protocol.id;
  this.protocol = protocol;
  this.version = null;
  // TODO: clean these up sometime
  this.heartbeat = null;
  this.idle_timeout = null;
  this.state = CONN_STATES.AUTH_WAIT;
  this.auth_timeout_id = auth_timeout_id;

  this.heartbeat_idle_period = 15000;
  this.disconnect_timeout = 60000;
  this.perms = [];
  this.protocol.once("close", this.destroy.bind(this));
};

util.inherits(BaseAgentHandler, events.EventEmitter);

BaseAgentHandler.prototype.CONN_STATES = CONN_STATES;
BaseAgentHandler.prototype.SUPPORTED_VERSIONS = SUPPORTED_VERSIONS;
BaseAgentHandler.prototype.CONN_STATES_REVERSE = CONN_STATES_REVERSE;

BaseAgentHandler.prototype.to_json = function () {
  const self = this;

  return {
    id: self.id,
  };
};

BaseAgentHandler.prototype.auth_timeout = function () {
  if (this.state > CONN_STATES.AUTH_WAIT) {
    return log.debug("client authed before timeout, but this interval should have been cancelled");
  }
  return this.disconnect("Took too long to send auth info.");
};

BaseAgentHandler.prototype.handle = function (msg) {
  const self = this;
  const req_id = msg.req_id;

  // Everyone can ack
  if (msg.name !== "ack" && !_.contains(self.perms, msg.name)) {
    log.error("%s action %s not allowed. perms: %s", self.toString(), msg.name, self.perms);
    return self.disconnect("You are not allowed to " + msg.name);
  }

  const f_name = "on_" + msg.name;
  try {
    log.debug("Calling %s", f_name);
    if (_.isFunction(self[f_name])) {
      self.ping();
      self[f_name](req_id, msg);
    } else {
      log.error("%s No function %s msg %s", self.toString(), f_name, msg);
      self.error(req_id, util.format("Unknown action: %s", msg.name), false);
      return self.disconnect();
    }
  } catch (e) {
    try {
      msg = JSON.stringify(msg, null, 2);
    } catch (e2) {
      log.error("Error stringifying message:", e2);
    }
    log.error("%s calling %s msg %s\n%s", self.toString(), f_name, msg, e, e.stack);
    return self.disconnect();
  }
};

BaseAgentHandler.prototype.write = function (name, res_id, json, cb) {
  const self = this;

  if (self.state < CONN_STATES.JOINED) {
    log.warn("client %s: Discarding event %s because conn state is %s", self.toString(), name, self.state);
    return cb && cb("Not joined yet");
  }

  if (self.state >= CONN_STATES.DESTROYED) {
    log.error("Somebody called write after we destroyed connection %s!", self.id);
    log.error("Event: %s", name);
    console.trace();
    return cb && cb("Connection is destroyed");
  }

  json.name = name;
  self.protocol.respond(res_id, json, cb);
};

BaseAgentHandler.prototype.request = function (name, json, cb) {
  const self = this;

  if (self.state < CONN_STATES.JOINED) {
    log.warn("client %s: Discarding event %s because conn state is %s", self.toString(), name, self.state);
    return cb && cb("Not joined yet");
  }

  if (self.state >= CONN_STATES.DESTROYED) {
    log.error("Somebody called write after we destroyed connection %s!", self.id);
    log.error("Event: %s", name);
    console.trace();
    return cb && cb("Connection is destroyed");
  }

  json.name = name;
  self.protocol.request(json, cb);
};

BaseAgentHandler.prototype.destroy = function () {
  const self = this;

  if (self.state >= CONN_STATES.DESTROYED) {
    return;
  }
  utils.set_state(self, CONN_STATES.DESTROYED);
  self.heartbeat = clearTimeout(self.heartbeat);
  self.idle_timeout = clearTimeout(self.idle_timeout);
  self.auth_timeout_id = clearTimeout(self.auth_timeout_id);
  self.protocol.destroy();
  self.protocol = null;
};

BaseAgentHandler.prototype.disconnect = function (reason, cb) {
  const self = this;

  if (self.state >= CONN_STATES.DISCONNECTING) {
    return null;
  }

  log.log("Disconnecting client %s ip %s. Reason: %s", self.toString(), self.protocol.remote_address, reason);

  cb = cb && _.once(cb);

  if (!reason) {
    self.destroy();
    return cb && cb();
  }

  const timeout = setTimeout(function () {
    log.log("Timed out waiting on sending disconnect event. Destroying connection.");
    self.destroy();
    return cb && cb();
  }, 2000);

  // Order is really important here.
  // the write callback can fire synchronously if conn is dead, causing a stack explosion if state isn't disconnecting
  utils.set_state(self, CONN_STATES.DISCONNECTING);
  self.write("disconnect", null, {reason: reason}, function () {
    clearTimeout(timeout);
    self.destroy();
    return cb && cb();
  });
};

BaseAgentHandler.prototype.name = "base handler";

BaseAgentHandler.prototype.toString = function () {
  const self = this;
  return util.format("conn_id %s %s", self.id, self.name);
};

BaseAgentHandler.prototype.error = function (req_id, msg, flash, cb) {
  const self = this;
  self.write("error", req_id, {"msg": msg, "flash": !!flash}, cb);
  log.warn("Error sent to %s (req_id %s): %s", self.toString(), req_id, msg);
};

BaseAgentHandler.prototype.handle_forwarded_options = function (data) {
  const self = this;
  const opts = data._forward_options;

  log.log("%s forwarded options:", self.toString(), opts);

  // TODO: only allow forwarded options from private IPs
  if (opts) {
    // Forwarded connection from colabalancer
    self.is_ssl = opts.ssl;
    self.remote_address = opts.remote_address;
  } else {
    // Direct connection from client
    self.is_ssl = self.protocol.is_ssl;
    self.remote_address = self.protocol.remote_address;
  }
};

BaseAgentHandler.prototype.on_ping = function (req_id) {
  this.protocol.respond(req_id, {name: "pong"});
};

BaseAgentHandler.prototype.ping = function () {
  const self = this;
  clearTimeout(self.heartbeat);
  clearTimeout(self.idle_timeout);
  self.heartbeat = setTimeout(function () {
    self.protocol.request({name: "ping"}, function () {
      self.idle_timeout = setTimeout(self.disconnect.bind(self), self.disconnect_timeout);
    });
  }, self.heartbeat_idle_period);
};

BaseAgentHandler.prototype.on_pong = function () {
  this.ping();
};

BaseAgentHandler.prototype.ack = function (req_id) {
  const self = this;
  self.protocol.ack(req_id);
};

BaseAgentHandler.prototype.on_ack = function () {
  return;
};

module.exports = BaseAgentHandler;
