"use strict";

const test = require("./test");
const patch = test.patch;
const verify = test.verify;
const agents = test.agents;

function tabs(t) {
  agents[0].buf = "blah\n\tblah\n\tblah\n";
  agents[1].buf = "blah\n\tblah\n\tblah\n";

  patch(agents[0], "blah\n\t  blah\n\tblah\n");

  agents[0].pop_patch(-1);

  verify(t, [agents[0], agents[1]]);
  t.done();
}

module.exports = {
  setUp: test.setup,
  test1: tabs,
  tearDown: test.teardown,
};
