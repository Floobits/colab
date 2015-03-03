/*jslint node: true */
"use strict";
var util = require("util");

var log = require("floorine");
var DMP = require("native-diff-match-patch");
var _ = require("lodash");
var fs = require("fs-extra");

var room = require("room");
var settings = require("settings");
var utils = require("utils");
var ldb = require("ldb");

var mock = require("mock");

var buf;
var agent_id = 0;
var r;
var agent1, agent2;

log.set_log_level("debug");
settings.bufs_dir = "/tmp/colab_test";


function patch(agent, after) {
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
}

function verify(test, agents) {
  log.log("buf is", buf._state);
  _.each(agents, function (agent) {
    test.strictEqual(buf._state.toString(), agent.buf, util.format("agent %s does not match!", agent.toString()));
  });
  console.log("\n------------------------------\n");
}

function setup(cb) {
  /*eslint-disable no-sync */
  fs.mkdirsSync(ldb.get_db_path(-1));
  /*eslint-enable no-sync */
  log.set_log_level("debug");
  r = new room.Room(-1, "fake_room", "fake_owner", {
    cur_fid: 0,
    max_size: 2147483647,
  }, {
    workspaces: {},
    db: {
      get: function (key, get_cb) {
        if (key !== "version_-1") {
          return get_cb("WTF wrong workspace ID");
        }
        return get_cb(null, 1);
      }
    }
  });

  agent1 = new mock.FakeAgentHandler(r, ++agent_id);
  agent2 = new mock.FakeAgentHandler(r, ++agent_id);

  r.once("load", function (err) {
    if (err) {
      throw new Error(err);
    }
    buf = mock.buf.make(r, 0, "test.txt", "abc", undefined, true, "utf8");
    // Set this so the test doesn't hang for 90 seconds before exiting.
    buf.save_timeout = 1;

    r.bufs[buf.id] = buf;
    r.tree_add_buf(buf);

    agent1.on_room_load();
    agent2.on_room_load();

    log.set_log_level("debug");
    cb();
  });

  r.load(agent1, {
    createIfMissing: true,
  });
}

function teardown(cb) {
  cb();
}

module.exports = {
  agent1: agent1,
  agent2: agent2,
  agent_id: agent_id,
  buf: buf,
  patch: patch,
  r: r,
  setup: setup,
  teardown: teardown,
  verify: verify,
};
