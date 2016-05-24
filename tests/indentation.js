"use strict";

const basename = require("path").basename;
const util = require("util");

const test = require("./test");
const patch = test.patch;
const verify = test.verify;
const agents = test.agents;

function tabs(t) {
  patch(agents[0], "blah\n\tblah\n\tblah\n");
  patch(agents[1], "blah\n\tblah\n\tblah\n");
  agents[0].pop_patch(-1);
  agents[1].pop_patch(-1);

  patch(agents[0], "blah\n\t  blah\n\tblah\n");
  agents[0].pop_patch(-1);
  agents[1].pop_patch(-1);

  t.deepEqual(agents[0].events.error, [{
    "msg": util.format("Possible indentation mismatch! %s is indented with spaces, but you sent tabs. Check your indentation rules!", basename(agents[0].buf.path)),
    "flash": false,
    "name": "error"
  }]);
  // Other client should have a message about indentation mismatch
  t.strictEqual(agents[1].events.msg.length, 1);

  verify(t, agents);
  t.done();
}

module.exports = {
  setUp: test.setup,
  test1: tabs,
  tearDown: test.teardown,
};
