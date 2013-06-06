var util = require("util");

var dmp_module = require("diff_match_patch");
var DMP = new dmp_module.diff_match_patch();
var _ = require("underscore");

var log = require("log");
var room = require("room");
var utils = require("utils");

var mock = require("mock");

log.set_log_level("debug");

// GLOBALS
/*global agent1: true, agent2: true */
agent1 = null;
agent2 = null;

var r,
  buf;

var patch = function (agent, after) {
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

var verify = function (test, agents) {
  log.log("buf is", buf._state);
  _.each(agents, function (agent) {
    test.strictEqual(buf._state, agent.buf, util.format("agent %s does not match!", agent.toString()));
  });
  console.log("\n------------------------------\n");
};

var setup = function (cb) {
  log.set_log_level("error");
  r = new room.Room(-1, "fake_room", "fake_owner", {
    cur_fid: 0,
    max_size: 2147483647,
    require_ssl: false
  });
  buf = new mock.ColabBuffer(r, 0, "test.txt", "abc", undefined, true);
  // Set this so the test doesn't hang for 90 seconds before exiting.
  buf.save_timeout = 1;

  r.bufs[buf.id] = buf;
  r.tree_add_buf(buf);

  agent1 = new mock.FakeAgentConnection(r, 1);
  agent2 = new mock.FakeAgentConnection(r, 2);
  log.set_log_level("debug");
  cb();
};

var teardown = function (cb) {
  cb();
};

module.exports = {
  setup: setup,
  teardown: teardown,
  patch: patch,
  verify: verify
};
