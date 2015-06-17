"use strict";
const util = require("util");

const _ = require("lodash");
const DMP = require("native-diff-match-patch");
const fs = require("fs-extra");
const log = require("floorine");

const buffer = require("../lib/buffer");
const ldb = require("../lib/ldb");
const room = require("../lib/room");
const settings = require("../lib/settings");
const utils = require("../lib/utils");

const mock = require("./mock");

process.on("uncaughtException", function (err) {
  console.error("Error:");
  console.error(err);
  console.error("Stack:");
  console.error(err.stack);
  /*eslint-disable no-process-exit */
  process.exit(1);
  /*eslint-enable no-process-exit */
});

log.set_log_level("debug");
settings.bufs_dir = "/tmp/colab_test";

let r = new room.Room(-1, {
  name: "fake_room",
  owner: "fake_owner",
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

let buf = buffer.make(r, 0, "test.txt", "abc", utils.md5("abc"), true, "utf8");
// Set this so the test doesn't hang for 90 seconds before exiting.
buf.save_timeout = 1;

let agent_id = 0;
let agent1 = mock.makeAgent(r, ++agent_id);
let agent2 = mock.makeAgent(r, ++agent_id);


function patch(agent, after) {
  let before = agent.buf;
  if (buf.encoding === "utf8") {
    before = before.toString();
  }

  const md5_before = utils.md5(before);
  const md5_after = utils.md5(after);
  const patches = DMP.patch_make(before, after);

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

  r.once("load", function (err) {
    if (err) {
      throw new Error(err);
    }

    r.bufs[buf.id] = buf;
    r.tree_add_buf(buf);

    agent1.on_room_load();
    agent2.on_room_load();

    cb();
  });

  r.load(agent1, {
    createIfMissing: true,
  });
}

function teardown(cb) {
  log.log("All done. Tearing down.");
  cb();
}

module.exports = {
  agent1,
  agent2,
  agent_id,
  buf,
  patch,
  r,
  setup,
  teardown,
  verify,
};
