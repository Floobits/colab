"use strict";

const test = require("./test");
const patch = test.patch;
const verify = test.verify;
const agent1 = test.agent1;
const agent2 = test.agent2;

function tabs(t) {
  agent1.buf = "blah\n\tblah\n\tblah\n";
  agent2.buf = "blah\n\tblah\n\tblah\n";

  patch(agent1, "blah\n\t  blah\n\tblah\n");

  agent1.pop_patch(-1);

  verify(t, [agent1, agent2]);
  t.done();
}

module.exports = {
  setUp: test.setup,
  test1: tabs,
  tearDown: test.teardown,
};
