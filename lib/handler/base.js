/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var events = require("events");
var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var MSG = require("../msg");
var Repo = require("../repo");
var Room = require("../room");
var perms = require("../perms");
var utils = require("../utils");
var settings = require('../settings');

var CONN_STATES = {
  AUTH_WAIT: 1,
  JOINED: 2,
  DISCONNECTING: 3,
  DESTROYED: 4
};

var CONN_STATES_REVERSE = _.invert(CONN_STATES);

var SUPPORTED_VERSIONS = [0.03, 0.1, 0.11];

var BaseAgentHandler = function (protocol, auth_timeout_id) {
  this.id = protocol.id;
  this.protocol = protocol;
  this.version = null;
  // TODO: clean these up sometime
  this.metrics_interval = null;
  this.heartbeat = null;
  this.idle_timeout = null;
  this.state = CONN_STATES.AUTH_WAIT;
  this.auth_timeout_id = auth_timeout_id;

  this.heartbeat_idle_period = 15000;
  this.disconnect_timeout = 60000;
  this.perms = [];
  this.protocol.on("close", this.destroy.bind(this));
};

util.inherits(BaseAgentHandler, events.EventEmitter);

BaseAgentHandler.prototype.CONN_STATES = CONN_STATES;
BaseAgentHandler.prototype.SUPPORTED_VERSIONS = SUPPORTED_VERSIONS;
BaseAgentHandler.prototype.CONN_STATES_REVERSE = CONN_STATES_REVERSE;

BaseAgentHandler.prototype.to_json = function () {
  var self = this;

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
  var self = this,
    req_id = msg.req_id,
    f_name;

  // Everyone can ack
  if (msg.name !== "ack" && !_.contains(self.perms, msg.name)) {
    log.error("action", msg.name, "not allowed");
    return self.disconnect("You are not allowed to " + msg.name);
  }

  f_name = "on_" + msg.name;
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
    log.error("%s calling %s msg %s\n%s", self.toString(), f_name, msg, e, e.stack);
    return self.disconnect();
  }
};

BaseAgentHandler.prototype.write = function (name, res_id, json, cb) {
  var self = this;

  if (self.state < CONN_STATES.JOINED) {
    log.warn("client %s: Discarding event %s because conn state is %s", self.toString(), name, self.state);
    return cb && cb();
  }

  if (self.state >= CONN_STATES.DESTROYED) {
    log.error("Somebody called write after we destroyed connection %s!", self.id);
    log.error("Event: %s", name);
    console.trace();
    return cb && cb();
  }

  json.name = name;
  self.protocol.respond(res_id, json, cb);
};

BaseAgentHandler.prototype.request = function (name, json, cb) {
  var self = this;

  if (self.state < CONN_STATES.JOINED) {
    log.warn("client %s: Discarding event %s because conn state is %s", self.toString(), name, self.state);
    return cb && cb();
  }

  if (self.state >= CONN_STATES.DESTROYED) {
    log.error("Somebody called write after we destroyed connection %s!", self.id);
    log.error("Event: %s", name);
    console.trace();
    return cb && cb();
  }

  json.name = name;
  self.protocol.request(json, cb);
};

BaseAgentHandler.prototype.destroy = function () {
  utils.set_state(this, CONN_STATES.DESTROYED);
  this.cleanup();
  this.protocol.destroy();
};

BaseAgentHandler.prototype.cleanup = function () {
  var self = this;

  self.heartbeat = clearTimeout(self.heartbeat);
  self.idle_timeout = clearTimeout(self.idle_timeout);
  self.auth_timeout_id = clearTimeout(this.auth_timeout_id);

  utils.set_state(self, CONN_STATES.DISCONNECTING);
};

BaseAgentHandler.prototype.disconnect = function (reason, cb) {
  var self = this, timeout;

  if (self.state >= CONN_STATES.DISCONNECTING) {
    return;
  }

  log.log("Disconnecting client %s ip %s. Reason: %s", self.toString(), self.protocol.remote_address, reason);

  cb = cb && _.once(cb);

  if (!reason) {
    self.destroy();
    return cb && cb();
  }

  timeout = setTimeout(function () {
    log.log("Timed out waiting on sending disconnect event. Destroying connection.");
    self.destroy();
    return cb && cb();
  }, 2000);

  self.write("disconnect", null, {reason: reason}, function () {
    clearTimeout(timeout);
    self.destroy();
    return cb && cb();
  });

  self.cleanup();
};

BaseAgentHandler.prototype.toString = function () {
  var self = this;
  return util.format("conn_id %s", self.protocol.id);
};

BaseAgentHandler.prototype.error = function (req_id, msg, flash) {
  var self = this;
  flash = !!flash;
  self.write("error", req_id, {"msg": msg, "flash": flash});
  log.warn("Error sent to %s (req_id %s): %s", self.toString(), req_id, msg);
};

BaseAgentHandler.prototype.handle_forwarded_options = function (data) {
  var self = this,
    opts = data._forward_options;

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
  var self = this;
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
  var self = this;

  self.protocol.ack(req_id);
};

BaseAgentHandler.prototype.on_ack = function () {
  return;
};

module.exports = BaseAgentHandler;
