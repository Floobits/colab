var events = require("events");
var fs = require("fs");
var path = require("path");
var util = require("util");

var async = require("async");
var dmp_module = require("diff_match_patch");
var DMP = new dmp_module.diff_match_patch();
var _ = require("underscore");

var agent = require("agent");
var ColabBuffer = require("../lib/buffer");
var log = require("log");
var room = require("room");
var utils = require("utils");


log.set_log_level("debug");

var MockConn = function (agent) {
  var self = this;
  events.EventEmitter.call(self);
  self.agent = agent;
};

util.inherits(MockConn, events.EventEmitter);

MockConn.prototype.write = function (name, data) {
  var self = this;
//  console.log(self.agent.toString(), "name:", name, "data:", JSON.stringify(data, null, 2));
};


var FakeAgentConnection = function (r, agent_id) {
  var self = this,
    conn = new MockConn(self),
    room_info;

  agent.AgentConnection.call(self, agent_id, conn, null);

  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = null;
  self.username = self.toString();
  self.secret = "aoeuidhtns";
  self.client = "FAKE";
  self.version = "0.02";//agent.SUPPORTED_VERSIONS.slice(-1)[0];
  self.platform = "FAKE_PLATFORM";
  self.authenticated = true;
  self.user_id = -1;
  self.perms = [];
  _.each(utils.db_perms_mapping, function (perms, codename) {
    self.perms = self.perms.concat(perms);
  });
  self.perms = _.uniq(self.perms);

  self.room = r;
  r.agents[self.id] = self;
  self.bufs = r.bufs;

  room_info = self.room.to_json();
  // add_agent munges agent.perms :/
  room_info.perms = self.perms;

  self.write("room_info", room_info);

  self.buf = self.bufs[0]._state;
  self.lag = 0;
  self.patch_events = [];

  r.on("dmp", self.dmp_listener);
  r.emit("dmp", self, "join", {
    "client": self.client,
    "platform": self.platform,
    "user_id": self.id,
    "username": self.username
  });
};

util.inherits(FakeAgentConnection, agent.AgentConnection);

FakeAgentConnection.prototype.toString = function () {
  var self = this;
  return util.format("agent%s", self.id);
};

FakeAgentConnection.prototype.log_buf = function () {
  var self = this;
  log.log(self.toString(), "buf is", self.buf);
};

FakeAgentConnection.prototype.pop_patch = function() {
  var self = this,
    data;
  data = self.patch_events.shift();
  if (data) {
    self.patch(data.patch, data.md5_before, data.md5_after);
  } else {
    log.warn("No more patches to apply.");
  }
};

FakeAgentConnection.prototype.patch = function(patch_text, md5_before, md5_after) {
  var self = this,
    buf = self.buf,
    patches,
    result;

  patches = DMP.patch_fromText(patch_text);
  result = DMP.patch_apply(patches, buf);
  if (utils.patched_cleanly(result) === false) {
    log.error("Patch wasn't applied!", result);
    return;
  }
  log.log(self.toString(), "patched from", self.buf, "to", result[0]);
  self.buf = result[0];
};

FakeAgentConnection.prototype.write = function (name, data) {
  var self = this;

  self.conn.write(name, data);

  if (name === "patch") {
    self.patch_events.push(data);
  } else if (name === "get_buf") {
    throw new Error(util.format("%s OH NO! GET BUF", self.toString()));
  }
};


ColabBuffer.prototype.save = function (create, cb) {
  cb();
};


var patch = function (agent, after, buf) {
  var before,
    md5_before,
    md5_after,
    patches,
    patch_text;

  before = agent.buf;

  md5_before = utils.md5(before);
  md5_after = utils.md5(after);
  patches = DMP.patch_make(before, after);
  patch_text = DMP.patch_toText(patches);

  log.log(agent.toString(), "sending patch from", agent.buf, "to", after);
  agent.buf = after;
  buf.patch(agent, patch_text, md5_before, md5_after);
  log.log("buf state is", buf._state);
};


var verify = function (test, buf, agents) {
  log.log("buf is", buf._state);
  _.each(agents, function (agent) {
    test.strictEqual(buf._state, agent.buf, util.format("agent %s does not match!", agent.toString()));
  });
};

var agent1,
  agent2,
  r,
  buf;

var setup = function (cb) {
  log.set_log_level("error");
  r = new room.Room(-1, "fake_room", "fake_owner", {
    cur_fid: 0,
    max_size: 2147483647,
    require_ssl: false
  });
  buf = new ColabBuffer(r, 0, "test.txt", "abc", undefined, true);
  // Set this so the test doesn't hang for 90 seconds before exiting.
  buf.save_timeout = 1;

  r.bufs[buf.id] = buf;
  r.tree_add_buf(buf);

  agent1 = new FakeAgentConnection(r, 1);
  agent2 = new FakeAgentConnection(r, 2);
  log.set_log_level("debug");
  cb();
};

var teardown = function (cb) {
  cb();
};

var test1 = function (test) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcd", buf);
  patch(agent1, "abcde", buf);
  patch(agent2, "abcd", buf);

  agent2.pop_patch();
  agent2.pop_patch();
  agent2.pop_patch();
  agent2.pop_patch();

  agent1.pop_patch();
  agent1.pop_patch();

  verify(test, buf, [agent1, agent2]);
  test.done();
};

var test2 = function (test) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcd", buf);
  patch(agent1, "abcde", buf);
  patch(agent2, "abcf", buf);

  agent2.pop_patch();
  agent2.pop_patch();
  agent2.pop_patch();
  agent2.pop_patch();

  agent1.pop_patch();
  agent1.pop_patch();

  verify(test, buf, [agent1, agent2]);
  test.done();
};

var test3 = function (test) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcd", buf);
  patch(agent1, "abcde", buf);

  patch(agent2, "abcd", buf);
  patch(agent2, "abcde", buf);
  patch(agent2, "abcdef", buf);

  agent2.pop_patch();
  agent2.pop_patch();
  agent2.pop_patch();
  agent2.pop_patch();
  agent2.pop_patch();

  agent1.pop_patch();
  agent1.pop_patch();
  agent1.pop_patch();

  verify(test, buf, [agent1, agent2]);
  test.done();
};


module.exports = {
  setUp: setup,
  tearDown: teardown,
  test1: test1,
  test2: test2,
  test3: test3,
};
