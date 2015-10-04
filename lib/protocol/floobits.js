"use strict";

const events = require("events");
const util = require("util");

const _ = require("lodash");
const log = require("floorine");

const actions = require("../actions");
const AgentHandler = require("../handler/agent");
const CreateUserHandler = require("../handler/create_user");
const CredentialsHandler = require("../handler/credentials");
const ReplicationClientHandler = require("../handler/replication_client");
const settings = require("../settings");
const SlaveHandler = require("../handler/slave");


const FloobitsProtocol = function (id, max_buf_len) {
  var self = this;

  events.EventEmitter.call(self);

  self.cleanup();
  self.id = id;
  // Due to how we calculate bytes sent and base64, 2x max_buf_len isn't quite enough
  self.max_buf_len = max_buf_len || settings.max_buf_len * 3;
};

util.inherits(FloobitsProtocol, events.EventEmitter);

FloobitsProtocol.prototype.toString = function () {
  var self = this;
  return util.format("conn_id %s ssl %s client %s", self.id, self.is_ssl, self.remote_address);
};

FloobitsProtocol.prototype.init_conn = function (conn, is_ssl) {
  var self = this;

  self.conn = conn;
  self.is_ssl = is_ssl;
  self.auth_timeout_id = setTimeout(self.disconnect_unauthed_client.bind(self), settings.auth_timeout);
  self.remote_address = conn.remoteAddress;
  self.remote_family = conn.remoteFamily;

  self.errored = false;

  conn.on("data", self.on_data.bind(self));
  conn.on("error", self.on_error.bind(self));
  conn.once("close", self.destroy.bind(self));
};

FloobitsProtocol.prototype.install_handler = function (Klass, server) {
  if (this.handler !== null) {
    throw new Error(util.format("Handler already exists for %s: %s", this.toString(), this.handler.toString()));
  }
  log.log("Installing handler %s", Klass.name);

  // timeout is now the handlers responsibility
  this.handler = new Klass(this, this.auth_timeout_id, server);
  this.name = this.handler.name;
  this.auth_timeout_id = null;
  actions.conn.handler(this.id, this.handler);
  return this.handler;
};

FloobitsProtocol.prototype.disconnect_unauthed_client = function () {
  var self = this;

  if (!self.handler) {
    return self.disconnect("Took too long to send auth info.");
  }

  return self.handler.auth_timeout();
};

FloobitsProtocol.prototype.on_error = function (err) {
  var self = this;

  // Prevent stack explosion (disconnect calls write, write errors, error fires disconnect, etc)
  if (self.errored) {
    return;
  }

  self.errored = true;
  self.disconnect(err);
};

FloobitsProtocol.prototype.disconnect = function (msg, cb) {
  var self = this;

  if (self.handler) {
    self.handler.disconnect(msg, cb);
    return;
  }

  log.warn("Destroying %s with no handler: %s", self.toString(), msg);
  self.destroy();

  if (cb) {
    cb();
  }
};

FloobitsProtocol.prototype.cleanup = function () {
  var self = this;
  self.handler = null;
  self.conn = null;
  self.buf = "";

  // Requests from client
  self.req_id = 0;
  self.reqs = {};

  // Our side of things
  self.server_req_id = 0;
  self.server_req_cbs = {};
  self.server_reqs = {};

  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = null;
};

FloobitsProtocol.prototype.log_data = function (msg, direction) {
  if (!settings.log_data) {
    return;
  }
  // User image stuff is really long
  if (msg.name === "datamsg" && msg.data && msg.data.name === "user_image") {
    return;
  }
  // Load info is also frequent and verbose. Squelch
  if (msg.name === "load") {
    return;
  }

  let handler = this.handler || this;
  log.debug("%s %s - %s: %s", direction, handler.name, handler.id, (this.handler ? "" : "NO HANDLER"), JSON.stringify(msg, null, 2));
};

FloobitsProtocol.prototype.handle_msg_ = function (msg) {
  var self = this,
    err = null,
    req_id,
    res_id;

  try {
    msg = JSON.parse(msg);
  } catch (e) {
    log.error("couldn't parse json:", msg, "error:", e);
    return self.disconnect();
  }

  self.log_data(msg, "from");

  if (_.has(msg, "res_id")) {
    res_id = msg.res_id;
    // Make sure res_id is an integer
    if (res_id % 1 !== 0) {
      log.error("%s bad res_id: %s", self.toString(), res_id);
      return self.disconnect();
    }
    if (res_id in self.server_reqs) {
      delete self.server_reqs[res_id];
      // Hacky. Don't change error msg in handler/base.js or this will break
      if (msg.name === "error") {
        err = msg.msg;
      }
    }
    if (res_id in self.server_req_cbs) {
      try {
        // Clone msg so callbacks can't modify it
        self.server_req_cbs[res_id](err, _.clone(msg));
      } catch (e) {
        log.error(e);
      }
      delete self.server_req_cbs[res_id];
    }
  } else if (_.has(msg, "req_id")) {
    req_id = msg.req_id;
    // Make sure req_id is an integer that is higher than the last req_id
    if (req_id % 1 === 0 && req_id > self.req_id) {
      self.req_id = req_id;
      self.reqs[req_id] = msg.name || "no name";
    } else {
      log.error("%s bad req_id: %s current: %s", self.toString(), req_id, self.req_id);
      return self.disconnect();
    }
  }

  if (self.handler) {
    return self.handler.handle(msg);
  }

  switch (msg.name) {
    case "request_credentials":
      self.install_handler(CredentialsHandler);
      self.handler.handle_forwarded_options(msg);
      self.handler.request(msg);
      break;
    case "supply_credentials":
      self.install_handler(CredentialsHandler);
      self.handler.handle_forwarded_options(msg);
      self.handler.supply(msg);
      break;
    case "create_user":
      self.install_handler(CreateUserHandler);
      self.handler.handle_forwarded_options(msg);
      self.handler.create(msg);
      break;
    case "slave":
      self.install_handler(SlaveHandler);
      self.handler.handle(msg);
      break;
    case "replicate":
      self.install_handler(ReplicationClientHandler);
      self.handler.auth(msg);
      break;
    default:
      self.install_handler(AgentHandler);
      self.handler.handle_forwarded_options(msg);
      self.handler.auth(msg);
      break;
  }
};

FloobitsProtocol.prototype.on_data = function (chunk) {
  var self = this,
    buf_len = self.buf.length,
    d_index,
    msg,
    newline_index;

  d_index = chunk.indexOf("\n");

  if (buf_len + d_index > self.max_buf_len) {
    log.error("Client %s message too big. Disconnecting. (%s + %s > %s)",
      self.toString(),
      buf_len,
      d_index,
      self.max_buf_len
    );
    self.disconnect("Sorry. Your client sent a message that is too big.");
    return;
  }

  self.buf += chunk;

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

FloobitsProtocol.prototype._write = function (json, cb) {
  var self = this,
    str = JSON.stringify(json);

  self.log_data(json, "to");

  try {
    self.conn.write(str);
    self.conn.write("\n", cb);
  } catch (e) {
    log.error("error writing to client %s: %s:\n%s", self.toString(), e, e.stack);
    // TODO: emit or something
    self.destroy();
    return cb && cb();
  }
};

FloobitsProtocol.prototype.respond = function (req_id, json, cb) {
  var self = this;

  if (req_id) {
    delete self.reqs[req_id];
    json.res_id = req_id;
  }

  return self._write(json, cb);
};

FloobitsProtocol.prototype.request = function (json, cb) {
  // cb called when we get a response with req_id
  var self = this,
    req_id = ++self.server_req_id;

  json.req_id = req_id;
  self.server_reqs[req_id] = json.name;
  if (cb) {
    self.server_req_cbs[req_id] = cb;
  }
  return self._write(json);
};

FloobitsProtocol.prototype.destroy = function () {
  var self = this,
    conn = self.conn;

  if (!conn) {
    return;
  }

  log.log("Destroying %s", self.toString());
  self.conn = null;

  conn.removeAllListeners("data");

  try {
    conn.end();
    conn.destroy();
  } catch (e) {
    log.error("Error destroying connection for %s: %s", self.toString(), e);
  }

  if (_.size(self.reqs) > 0) {
    log.warn("%s reqs un-acked by us destroyed %s:", _.size(self.reqs), self.toString());
    _.each(self.reqs, function (req, req_id) {
      log.warn("%s: %s", req_id, req);
    });
  }
  if (_.size(self.server_reqs) > 0) {
    log.warn("%s reqs un-acked by client destroyed %s:", _.size(self.server_reqs), self.toString());
    _.each(self.server_reqs, function (req, req_id) {
      log.warn("%s: %s", req_id, req);
    });
  }

  // order is really important
  actions.conn.end(self);
  self.emit("close");
  self.cleanup();
};

FloobitsProtocol.prototype.ack = function (req_id) {
  var self = this;

  if (!_.has(self.reqs, req_id)) {
    log.warn("%s: %s is not in reqs!", self.toString(), req_id);
  }

  delete self.reqs[req_id];

  if (!_.isFinite(req_id)) {
    log.warn("%s: req_id %s is not finite! not acking", self.toString(), req_id);
    return;
  }

  self.respond(req_id, {"name": "ack"});
};

module.exports = FloobitsProtocol;
