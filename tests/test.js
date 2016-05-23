"use strict";
const util = require("util");

const _ = require("lodash");
const async = require("async");
const fs = require("fs-extra");
const log = require("floorine");

const buffer = require("../lib/buffer");
const ldb = require("../lib/ldb");
const room = require("../lib/room");
const server = require("../lib/server");
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
settings.base_dir = "/tmp/colab_test_" + process.pid;
settings.log_level = "debug";
settings.json_port_ssl = null;

const test_server = new server.ColabServer();

const r = new room.Room(-1, {
  name: "fake_room",
  owner: "fake_owner",
  cur_fid: 0,
  max_size: 2147483647,
}, test_server);

let buf;
let i = 0;
let agent_id = 0;
let agent1 = mock.makeAgent(r, ++agent_id);
let agent2 = mock.makeAgent(r, ++agent_id);


function patch(agent, after) {
  let before = agent.buf;
  let patches;
  const dmp = buf.encoding === "utf8" ? buffer.JS_DMP : buffer.DMP;
  if (buf.encoding === "utf8") {
    before = before.toString();
    patches = dmp.patch_make(before, after);
    patches = dmp.patch_toText(patches);
  } else if (buf.encoding === "base64") {
    patches = dmp.patch_make(before, after);
  } else {
    throw new Error("INVALID BUFFER ENCODING!");
  }

  log.log(agent.toString(), "sending patch from", agent.buf, "to", after);
  agent.buf = after;
  const md5_before = utils.md5(before);
  const md5_after = utils.md5(after);
  buf.patch(agent, null, patches, md5_before, md5_after);
  log.log("buf state is", buf._state.toString());
}

function verify(test, agents) {
  log.log("buf is", buf._state.toString());
  _.each(agents, function (agent) {
    test.strictEqual(buf._state.toString(), agent.buf, util.format("agent %s does not match!", agent.toString()));
  });
  console.log("\n------------------------------\n");
}

function setup(cb) {
  /*eslint-disable no-sync */
  fs.mkdirsSync(ldb.get_db_path(-1));
  /*eslint-enable no-sync */

  r.once("load", function (err) {
    if (err) {
      throw new Error(err);
    }
    buf = buffer.make(r, 0, "test.txt", "abc", utils.md5("abc"), true, "utf8");

    r.bufs[buf.id] = buf;
    r.tree_add_buf(buf);

    agent1.on_room_load();
    agent2.on_room_load();

    r.create_buf(agent1, 1, util.format("test%s.txt", i), "abc", "utf8", cb);
    i++;
    // cb();
  });

  let auto = {
    leveldb_open: test_server.open_db.bind(test_server),
    get_server_id: ["leveldb_open", test_server.get_server_id.bind(test_server)],
    create_workspace: ["get_server_id", (cb) => {
      test_server.db.put(util.format("version_%s", r.id), 1, cb);
    }],
  };

  async.auto(auto, function (err) {
    if (err) {
      throw new Error(err);
    }
    r.load(agent1, {
      createIfMissing: true,
    });
  });
}

function teardown(cb) {
  log.log("All done. Tearing down.");
  test_server.db.close(cb);
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
