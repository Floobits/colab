"use strict";

var events = require("events");
var util = require("util");

var log = require("floorine");
var DMP = require("native-diff-match-patch");
// var diff_match_patch = require('diff_match_patch');
// var DMP = new diff_match_patch.diff_match_patch();
var _ = require("lodash");

var AgentHandler = require("handler/agent");
var buf = require("../lib/buffer");
var perms = require("perms");
var utils = require("utils");
var settings = require("settings");

var MockConn,
  FakeAgentHandler;

log.set_log_level("debug");

// DMP.Patch_DeleteThreshold = settings.dmp.Patch_DeleteThreshold;
// DMP.Match_Threshold = settings.dmp.Match_Threshold;
// DMP.Match_Distance = settings.dmp.Match_Distance;

DMP.set_Patch_DeleteThreshold(settings.dmp.Patch_DeleteThreshold);
DMP.set_Match_Threshold(settings.dmp.Match_Threshold);
DMP.set_Match_Distance(settings.dmp.Match_Distance);

MockConn = function (agent) {
  var self = this;
  events.EventEmitter.call(self);
  self.agent = agent;
};

util.inherits(MockConn, events.EventEmitter);

MockConn.prototype.write = function (name, req_id, data) {
  var self = this;
  if (settings.log_data) {
    console.log(self.agent.toString(), "name:", name, "req_id:", req_id, "data:", JSON.stringify(data, null, 2));
  }
};


FakeAgentHandler = function (r, agent_id) {
  var self = this,
    conn = new MockConn(self);

  AgentHandler.call(self, agent_id, conn, null);

  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = null;
  self.username = self.toString();
  self.secret = "aoeuidhtns";
  self.client = "FAKE";
  self.version = "0.11";//agent.SUPPORTED_VERSIONS.slice(-1)[0];
  self.platform = "FAKE_PLATFORM";
  self.authenticated = true;
  self.user_id = -1;
  self.perms = [];
  _.each(perms.db_perms_mapping, function (perm_map) {
    self.perms = self.perms.concat(perm_map);
  });
  self.perms = _.uniq(self.perms);

  self.room = r;
};

util.inherits(FakeAgentHandler, AgentHandler);

FakeAgentHandler.prototype.toString = function () {
  var self = this;
  return util.format("agent%s", self.id);
};

FakeAgentHandler.prototype.on_room_load = function () {
  var self = this,
    room_info;
  self.room.handlers[self.id] = self;

  self.bufs = self.room.bufs;

  room_info = self.room.room_info();
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

FakeAgentHandler.prototype.write = function (name, req_id, data) {
  var self = this;

  self.conn.write(name, req_id, data);
  log.log(self.id, name);
  if (name === "patch") {
    self.patch_events.push(data);
  } else if (name === "get_buf") {
    throw new Error(util.format("%s OH NO! GET BUF", self.toString()));
  }
};


buf.BaseBuffer.prototype.save = function (create, cb) {
  log.debug("save create: %s", create);
  cb();
};


module.exports = {
  FakeAgentHandler: FakeAgentHandler,
  buf: buf
};
