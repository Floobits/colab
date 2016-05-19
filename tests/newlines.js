"use strict";

const test = require("./test");
const patch = test.patch;
const verify = test.verify;
const agent1 = test.agent1;
const agent2 = test.agent2;

function crs(t) {
  agent1.buf = "1234\n5678\n9012\n3456\n";
  agent2.buf = "1234\n5678\n9012\n3456\n";

  patch(agent1, "1234\r\n5678\n9012\n3456\n");

  agent1.pop_patch(-1);

  verify(t, [agent1, agent2]);
  t.done();
}

module.exports = {
  setUp: test.setup,
  test1: crs,
  tearDown: test.teardown,
};
