/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var events = require("events");
var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var utils = require("./utils");
var settings = require('./settings');
var AgentHandler = require("./handler/agent");
var CreateUserHandler = require("./handler/create_user");
var CredentialsHandler = require("./handler/credentials");

var FloobitsProtocol = function (id, conn, server) {
  var self = this;

  events.EventEmitter.call(self);

  self.handler = null;
  self.buf = "";
  self.id = id;
  self.conn = conn;
  self.server = server;
  self.auth_timeout_id = setTimeout(self.disconnect_unauthed_client.bind(self), 10000);
  self.heartbeat = null;
  self.idle_timeout = null;
  self.outstanding_reqs = {};
  self.cur_req_id = 0;

  self.remote_address = this.conn.remoteAddress;
  self.is_ssl = false;
  if (conn.manager && server.server_ssl === conn.manager.server) {
    self.is_ssl = true;
  }
  if (conn.socket && server.server_ssl === conn.socket.server) {
    self.is_ssl = true;
  }

  conn.on("data", self.on_data.bind(self));
  conn.on("error", self.disconnect.bind(self));
  conn.on("close", function () {
    self.emit("on_conn_end", self);
  });
};

FloobitsProtocol.prototype.disconnect_unauthed_client = function () {
  var self = this;

  if (!self.handler) {
    return self.disconnect("Took too long to send auth info.");
  }

  return self.handler.auth_timeout();
};

FloobitsProtocol.prototype.handle_msg_ = function (msg) {
  var self = this, req_id;

  try {
    msg = JSON.parse(msg);
  } catch (e) {
    log.error("couldn't parse json:", msg, "error:", e);
    return self.disconnect();
  }

  try {
    if (_.has(msg, "req_id")) {
      // Make sure req_id is an integer that is higher than the last req_id
      if (msg.req_id % 1 === 0 && msg.req_id > self.cur_req_id) {
        req_id = msg.req_id;
        self.cur_req_id = req_id;
        self.outstanding_reqs[req_id] = msg.name || "no name";
      } else {
        log.error("%s bad req_id: %s", self.toString(), msg.req_id);
        return self.disconnect();
      }
    }
  } catch (e) {
    log.error("%s handling msg %s", self.toString(), msg, e);
    return self.disconnect();
  }

  // TODO: KANS: this isn't quite the same as checking the state...
  if (!self.handler) {
    return self.handler.handle(msg);
  }

  switch (msg.name) {
  case "request_credentials":
    self.handler = new CredentialsHandler(this, self.auth_timeout_id);
    self.handler.request(msg);
    break;
  case "supply_credentials":
    self.handler = new CredentialsHandler(this, self.auth_timeout_id);
    self.handler.supply(msg);
    break;
  case "create_user":
    self.handler = new CreateUserHandler(this, self.auth_timeout_id);
    self.handler.create(msg);
    break;
  default:
    self.handler = new AgentHandler(this, self.auth_timeout_id);
    self.handler.auth(msg);
    break;
  }
  // timeout is now the handlers responsibility
  self.auth_timeout_id = null;
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
    newline_index = self.buf.indexOf("\n");
    self.handle_msg_(msg);
  }
};

FloobitsProtocol.prototype.write = function (res_id, json, cb) {
  var self = this,
    str;

  if (res_id) {
    delete self.outstanding_reqs[res_id];
    json.res_id = res_id;
  }
  
  str = JSON.stringify(json);

  try {
    self.conn.write(str);
    self.conn.write("\n", cb);
  } catch (e) {
    log.error("error writing to client %s: %s. disconnecting.", self.toString(), e);
    // TODO: emit or something
    self.destroy();
    return cb && cb();
  }
};

FloobitsProtocol.prototype.destroy = function () {
  var self = this;

  if (!self.conn && !self.server) {
    return;
  }

  log.log("Destroying %s", self.toString());

  if (_.size(self.outstanding_reqs) > 0) {
    log.warn("%s outstanding reqs for destroyed client %s:", _.size(self.outstanding_reqs), self.toString());
    _.each(self.outstanding_reqs, function (req, req_id) {
      log.warn("%s: %s", req_id, req);
    });
  }

  try {
    self.stop_metrics();
  } catch (ignore) { }

  if (self.conn) {
    try {
      self.conn.end();
      self.conn.destroy();
    } catch (e) {
      log.error("Error destroying connection for %s: %s", self.toString(), e);
    }
    self.conn = null;
  }

  if (self.server) {
    self.server = null;
  }
};

