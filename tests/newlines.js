"use strict";

const test = require("./test");
const patch = test.patch;
const verify = test.verify;
const agents = test.agents;

function crs(t) {
  // agents[0].buf = "1234\n5678\n9012\n3456\n";
  // agents[1].buf = "1234\n5678\n9012\n3456\n";

  patch(agents[0], "1234\n5678\n9012\n3456\n");
  patch(agents[0], "1234\r\n5678\n9012\n3456\n");

  agents[0].pop_patch(-1);

  verify(t, agents);
  t.done();
}

module.exports = {
  setUp: test.setup,
  test1: crs,
  tearDown: test.teardown,
};
