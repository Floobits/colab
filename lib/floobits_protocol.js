/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var events = require("events");
var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var utils = require("./utils");
var settings = require('./settings');

var SUPPORTED_VERSIONS = [0.01, 0.02, 0.03, 0.1, 0.11];

var CONN_STATES = {
  AUTH_WAIT: 1,
  JOINED: 2,
  DISCONNECTING: 3,
  DESTROYED: 4
};

var CONN_STATES_REVERSE = _.invert(CONN_STATES);

var FloobitsProtocol = function (id, conn, server) {
  var self = this;

  events.EventEmitter.call(self);

  self.handler = null;
  self.buf = "";
  self.id = id;
  self.conn = conn;
  self.server = server;
  self.is_ssl = null;
  self.remote_address = self._remote_address();
  self.state = CONN_STATES.AUTH_WAIT;
  self.perms = [];
  self.auth_timeout_id = setTimeout(self.disconnect_unauthed_client.bind(self), 10000);
  self.heartbeat = null;
  self.idle_timeout = null;
  self.outstanding_reqs = {};
  self.cur_req_id = 0;

  conn.on("data", self.on_data.bind(self));
  conn.on("error", self.disconnect.bind(self));
  conn.on("close", function () {
    self.emit("on_conn_end", self);
  });
};

FloobitsProtocol.prototype.handle_msg = function (msg) {
  var self = this, f_name, req_id;

  try {
    msg = JSON.parse(msg);
  } catch (e) {
    log.error("couldn't parse json:", msg, "error:", e);
    return self.disconnect();
  }

  if (self.state === CONN_STATES.AUTH_WAIT) {
    switch (msg.name) {
    case "request_credentials":
      return self.request_credentials(msg);
    case "supply_credentials":
      return self.supply_credentials(msg);
    case "create_user":
      return self.create_user(msg);
    default:
      return self.auth(msg, function () { return; });
    }
  }

  if (!_.contains(self.perms, msg.name)) {
    log.error("action", msg.name, "not allowed");
    return self.disconnect();
  }

  f_name = "on_" + msg.name;
  try {
    log.debug("Calling %s", f_name);
    if (_.has(msg, "req_id")) {
      // Make sure req_id is an integener that is higher than the last req_id
      if (msg.req_id % 1 === 0 && msg.req_id > self.cur_req_id) {
        req_id = msg.req_id;
        self.cur_req_id = req_id;
        self.outstanding_reqs[req_id] = msg.name || "no name";
      } else {
        log.error("%s bad req_id: %s", self.toString(), msg.req_id);
        return self.disconnect();
      }
    }
    if (_.isFunction(self[f_name])) {
      self.ping();
      self[f_name](req_id, msg);
    } else {
      log.error("%s No function %s msg %s", self.toString(), f_name, msg);
      self.error(req_id, util.format("Unknown action: %s", msg.name), false);
      return self.disconnect();
    }
  } catch (e) {
    log.error("%s calling %s msg %s", self.toString(), f_name, msg, e);
    return self.disconnect();
  }
};

FloobitsProtocol.prototype.on_data = function (d) {
  var self = this,
    buf_len = self.buf.length,
    d_index = d.indexOf("\n"),
    msg,
    newline_index;

  if (settings.log_data) {
    log.debug("d: |%s|", d);
  }

  if (buf_len + Math.max(d_index, 0) > settings.max_buf_len) {
    return self.disconnect("Sorry. Your client sent a message that is too big.");
  }

  self.buf += d;

  if (d_index === -1) {
    return;
  }

  newline_index = buf_len + d_index;
  while (newline_index !== -1) {
    msg = self.buf.slice(0, newline_index);
    self.buf = self.buf.slice(newline_index + 1);
    self.handle_msg(msg);
    newline_index = self.buf.indexOf("\n");
  }
};

FloobitsProtocol.prototype.write = function (name, res_id, json, cb) {
  var self = this,
    str;

  if (res_id) {
    delete self.outstanding_reqs[res_id];
    json.res_id = res_id;
  }

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
  str = JSON.stringify(json);
  // User image stuff is really long
  if (name !== "datamsg" || (json.data && json.data.name !== "user_image")) {
    log.debug("writing to conn", self.id, ":", str);
  }
  try {
    self.conn.write(str);
    self.conn.write("\n", cb);
  } catch (e) {
    log.error("error writing to client %s: %s. disconnecting.", self.toString(), e);
    self.destroy();
    return cb && cb();
  }
};

FloobitsProtocol.prototype._remote_address = function () {
  var self = this;
  return self.conn.remoteAddress;
};
