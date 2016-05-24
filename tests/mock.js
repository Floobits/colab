"use strict";

const events = require("events");
const util = require("util");

const log = require("floorine");
const _ = require("lodash");

const AgentHandler = require("../lib/handler/agent");
const buffer = require("../lib/buffer");
const FloobitsProtocol = require("../lib/protocol/floobits");
const perms = require("../lib/perms");
const utils = require("../lib/utils");

const DMP = buffer.DMP;
const JS_DMP = buffer.JS_DMP;

const MockConn = function () {
  const self = this;
  events.EventEmitter.call(self);
};

util.inherits(MockConn, events.EventEmitter);

MockConn.prototype.write = function () {};
MockConn.prototype.end = function () {};
MockConn.prototype.destroy = function () {};


const FakeAgentHandler = function () {
  AgentHandler.apply(this, arguments);

  this.username = this.toString();
  this.secret = "aoeuidhtns";
  this.client = "FAKE";
  this.version = this.SUPPORTED_VERSIONS.slice(-1)[0];
  this.platform = "FAKE_PLATFORM";
  this.authenticated = true;
  this.user_id = -1;
  this.perms = [];
  this.buf = null;
};

util.inherits(FakeAgentHandler, AgentHandler);

FakeAgentHandler.prototype.name = "FAKE";

FakeAgentHandler.prototype.toString = function () {
  const self = this;
  return util.format("agent%s", self.id);
};

FakeAgentHandler.prototype.on_room_load = function () {
  const self = this;

  self.room.handlers[self.id] = self;

  let room_info = self.room.room_info();
  // add_agent munges agent.perms :/
  room_info.perms = self.perms;

  const buf = self.room.bufs[self.room.cur_fid];
  self.buf = {
    path: buf.path,
    _md5: buf._md5,
    _state: new Buffer(buf._state),
    encoding: buf.encoding,
    normalize: buf.normalize,
    toString: buf.toString,
  };
  self.lag = 0;
  self.patch_events = [];
  self.events = {};
  self.room.broadcast("join", self, null, self.to_json());
  self.write("room_info", null, room_info);
};

FakeAgentHandler.prototype.log_buf = function () {
  const self = this;
  log.log(self.toString(), "buf is", self.buf.toString());
};

FakeAgentHandler.prototype.pop_patch = function (count) {
  const self = this;

  count = count === -1 ? self.patch_events.length : (count || 1);

  while (count > 0) {
    const data = self.patch_events.shift();
    if (data) {
      log.debug("Popping patch %s", count);
      self.patch(data.patch, data.md5_before, data.md5_after);
    }
    count--;
  }
};

FakeAgentHandler.prototype.patch = function (patch_text, md5_before, md5_after) {
  const self = this;

  if (utils.md5(self.buf._state) === md5_before) {
    log.debug("md5_before %s OK", md5_before);
  } else {
    log.warn("md5_before should be %s but is %s", md5_before, utils.md5(self.buf._state));
  }
  let result;
  if (self.buf.encoding === "utf8") {
    let patches = JS_DMP.patch_fromText(patch_text);
    result = JS_DMP.patch_apply(patches, self.buf._state.toString());
  } else if (self.buf.encoding === "base64") {
    result = DMP.patch_apply(patch_text, self.buf._state);
  } else {
    throw new Error("INVALID ENCODING");
  }
  if (utils.patched_cleanly(result) === false) {
    log.error("%s Patch %s wasn't applied!", self.toString(), patch_text);
    log.error("Result %s", result);
    log.error("buf:", self.buf._state.toString());
    return;
  }
  if (utils.md5(self.buf._state) !== md5_after) {
    log.debug("md5_after %s OK", md5_after);
  } else {
    log.warn("md5_after should be %s but is %s", md5_after, utils.md5(self.buf._state));
  }
  log.log(self.toString(), "patched from", self.buf._state.toString(), "to", result[0]);
  self.buf._state = self.buf.normalize(result[0]);
};

FakeAgentHandler.prototype.write = function (name, req_id, data, cb) {
  const self = this;

  data = data || {};

  data.name = name;
  self.protocol.respond(req_id, data, cb);
  log.log(self.id, name);

  if (!self.events[name]) {
    self.events[name] = [];
  }
  self.events[name].push(data);

  if (name === "patch") {
    self.patch_events.push(data);
  } else if (name === "get_buf") {
    throw new Error(util.format("%s OH NO! GET BUF", self.toString()));
  }
  if (cb) {
    cb();
  }
};


function makeAgent (r, agent_id) {
  const protocol = new FloobitsProtocol(agent_id);
  const conn = new MockConn();

  protocol.init_conn(conn, true);

  const agent = protocol.install_handler(FakeAgentHandler);

  clearTimeout(agent.auth_timeout_id);
  agent.auth_timeout_id = null;

  utils.set_state(agent, agent.CONN_STATES.JOINED);

  _.each(perms.db_perms_mapping, function (perm_map) {
    agent.perms = agent.perms.concat(perm_map);
  });
  agent.perms = _.uniq(agent.perms);
  agent.room = r;
  return agent;
}


module.exports = {
  FakeAgentHandler,
  makeAgent,
};
