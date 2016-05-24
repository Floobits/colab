"use strict";

const basename = require("path").basename;
const util = require("util");

const test = require("./test");
const patch = test.patch;
const verify = test.verify;
const agents = test.agents;

function crs(t) {
  patch(agents[0], "1234\n5678\n9012\n3456\n");
  patch(agents[1], "1234\n5678\n9012\n3456\n");
  agents[0].pop_patch(-1);
  agents[1].pop_patch(-1);

  patch(agents[0], "1234\r\n5678\n9012\n3456\n");
  agents[0].pop_patch(-1);

  t.deepEqual(agents[0].events.error, [{
    "msg": util.format("Your editor sent a carriage return in %s. Check your newline rules!", basename(agents[0].buf.path)),
    "flash": false,
    "name": "error"
  }]);

  const buf = agents[0].buf;
  t.strictEqual(buf._state.toString(), "1234\r\n5678\n9012\n3456\n");
  // Lame hack so that verify works.
  buf._state = new Buffer(buf._state.toString().replace("\r", ""));

  verify(t, agents);
  t.done();
}

module.exports = {
  setUp: test.setup,
  test1: crs,
  tearDown: test.teardown,
};
