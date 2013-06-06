/*global agent1: true, agent2: true */
var test = require("test");

var patch = test.patch,
  verify = test.verify;


var test1 = function (test) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcd");
  patch(agent1, "abcde");
  patch(agent2, "abcd");

  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(test, [agent1, agent2]);
  test.done();
};

var test2 = function (test) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcd");
  patch(agent1, "abcde");
  patch(agent2, "abcf");

  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(test, [agent1, agent2]);
  test.done();
};

var test3 = function (test) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcd");
  patch(agent1, "abcde");

  patch(agent2, "abcd");
  patch(agent2, "abcde");
  patch(agent2, "abcdef");

  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(test, [agent1, agent2]);
  test.done();
};

var test4 = function(test){
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcde");
  patch(agent2, "abcdef");
  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(test, [agent1, agent2]);
  test.done();
}

var test5 = function(test){
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "ab");
  patch(agent2, "abcdef");
  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(test, [agent1, agent2]);
  test.done();
}


module.exports = {
  setUp: test.setup,
  tearDown: test.teardown,
  test1: test1,
  test2: test2,
  test3: test3,
  test4: test4,
  test5: test5
};
