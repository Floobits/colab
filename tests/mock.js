"use strict";

const events = require("events");
const util = require("util");

const log = require("floorine");
const DMP = require("native-diff-match-patch");
// const diff_match_patch = require('diff_match_patch');
// const DMP = new diff_match_patch.diff_match_patch();
const _ = require("lodash");

const AgentHandler = require("../lib/handler/agent");
const FloobitsProtocol = require("../lib/protocol/floobits");
const perms = require("../lib/perms");
const utils = require("../lib/utils");
const settings = require("../lib/settings");

log.set_log_level("debug");

// DMP.Patch_DeleteThreshold = settings.dmp.Patch_DeleteThreshold;
// DMP.Match_Threshold = settings.dmp.Match_Threshold;
// DMP.Match_Distance = settings.dmp.Match_Distance;

DMP.set_Patch_DeleteThreshold(settings.dmp.Patch_DeleteThreshold);
DMP.set_Match_Threshold(settings.dmp.Match_Threshold);
DMP.set_Match_Distance(settings.dmp.Match_Distance);

const MockConn = function () {
  var self = this;
  events.EventEmitter.call(self);
};

util.inherits(MockConn, events.EventEmitter);

MockConn.prototype.write = function (name, req_id, data) {
  if (!settings.log_data) {
    return;
  }
  console.log("name:", name, "req_id:", req_id, "data:", JSON.stringify(data, null, 2));
};


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
};

util.inherits(FakeAgentHandler, AgentHandler);

FakeAgentHandler.prototype.name = "FAKE";

FakeAgentHandler.prototype.toString = function () {
  var self = this;
  return util.format("agent%s", self.id);
};

FakeAgentHandler.prototype.on_room_load = function () {
  const self = this;

  self.room.handlers[self.id] = self;
  self.bufs = self.room.bufs;

  let room_info = self.room.room_info();
  // add_agent munges agent.perms :/
  room_info.perms = self.perms;

  self.write("room_info", room_info);

  self.buf = self.bufs[0]._state;
  self.lag = 0;
  self.patch_events = [];
  self.room.broadcast("join", self, null, self.to_json());
};

FakeAgentHandler.prototype.log_buf = function () {
  var self = this;
  log.log(self.toString(), "buf is", self.buf);
};

FakeAgentHandler.prototype.pop_patch = function (count) {
  var self = this,
    data;

  count = count === -1 ? self.patch_events.length : (count || 1);

  while (count > 0) {
    data = self.patch_events.shift();
    if (data) {
      self.patch(data.patch, data.md5_before, data.md5_after);
    }
    count--;
  }
};

FakeAgentHandler.prototype.patch = function (patch_text, md5_before, md5_after) {
  var self = this,
    result;

  if (utils.md5(self.buf) === md5_before) {
    log.debug("md5_before %s OK", md5_before);
  } else {
    log.warn("md5_before should be %s but is %s", md5_before, utils.md5(self.buf));
  }
  // patches = DMP.patch_fromText(patch_text);
  result = DMP.patch_apply(patch_text, self.buf);
  if (utils.patched_cleanly(result) === false) {
    log.error("%s Patch %s wasn't applied!", self.toString(), patch_text);
    log.error("Result %s", result);
    log.error("buf:", self.buf);
    return;
  }
  if (utils.md5(self.buf) !== md5_after) {
    log.debug("md5_after %s OK", md5_after);
  } else {
    log.warn("md5_after should be %s but is %s", md5_after, utils.md5(self.buf));
  }
  log.log(self.toString(), "patched from", self.buf, "to", result[0]);
  self.buf = result[0];
};

FakeAgentHandler.prototype.write = function (name, req_id, data, cb) {
  const self = this;

  data = data || {};

  data.name = name;
  self.protocol.respond(req_id, data, cb);
  log.log(self.id, name);
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
