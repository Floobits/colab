/*global agent_id: true, r: true, agent1: true, agent2: true */
var util = require("util");

var log = require("floorine");
var DMP = require("native-diff-match-patch");
var _ = require("lodash");

var room = require("room");
var settings = require("settings");
var utils = require("utils");

var mock = require("mock");

log.set_log_level("debug");

var buf;
agent_id = 0;


settings.bufs_dir = "/tmp/colab_test";


var patch = function (agent, after) {
  var before,
    md5_before,
    md5_after,
    patches;

  before = agent.buf;
  if (buf.encoding === "utf8") {
    before = before.toString();
  }

  md5_before = utils.md5(before);
  md5_after = utils.md5(after);
  patches = DMP.patch_make(before, after);

  log.log(agent.toString(), "sending patch from", agent.buf, "to", after);
  agent.buf = after;
  buf.patch(agent, null, patches, md5_before, md5_after);
  log.log("buf state is", buf._state);
};

var verify = function (test, agents) {
  log.log("buf is", buf._state);
  _.each(agents, function (agent) {
    test.strictEqual(buf._state.toString(), agent.buf, util.format("agent %s does not match!", agent.toString()));
  });
  console.log("\n------------------------------\n");
};

var setup = function (cb) {
  log.set_log_level("debug");
  r = new room.Room(-1, "fake_room", "fake_owner", {
    cur_fid: 0,
    max_size: 2147483647,
  }, {
    workspaces: {},
    db: {
      get: function (cb) {
        return cb(1);
      }
    }
  });
  r.once("load", function () {
    buf = new mock.buf.make_buffer(r, 0, "test.txt", "abc", undefined, true, "utf8");
    // Set this so the test doesn't hang for 90 seconds before exiting.
    buf.save_timeout = 1;

    r.bufs[buf.id] = buf;
    r.tree_add_buf(buf);

    agent1 = new mock.FakeAgentConnection(r, ++agent_id);
    agent2 = new mock.FakeAgentConnection(r, ++agent_id);

    log.set_log_level("debug");
    cb();
  });
  r.load();
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
