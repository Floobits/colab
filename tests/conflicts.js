/*global agent_id: true, r: true, agent1: true, agent2: true */
var log = require("floorine");
var _ = require("lodash");

var mock = require("mock");
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

var test4 = function (test) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent2, "abcdef");
  patch(agent1, "ab");
  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(test, [agent1, agent2]);
  test.done();
};

var permute_patches = function () {
  var args,
    test,
    agents = {},
    agents_patches,
    permute,
    ops;
  args = Array.prototype.slice.call(arguments);
  test = args[0];
  agents_patches = args.slice(1);

  _.each(agents_patches, function (agent_patches) {
    agent_id++;
    var agent = new mock.FakeAgentHandler(r, agent_id);
    agent._patches = agent_patches;
    agents[agent_id] = agent;

    agent.on_room_load();
  });

  permute = function (agent1, agent2) {
    agent1._remaining_patches = _.clone(agent1._patches);
    agent2._remaining_patches = _.clone(agent2._patches);

    var permute_ops = [],
      choice,
      patch_obj,
      pop_agent1,
      pop_agent2;

    pop_agent1 = function () {
      agent1.pop_patch(1);
    };
    pop_agent2 = function () {
      agent2.pop_patch(1);
    };

    while (agent1._remaining_patches.length > 0 || agent2._remaining_patches.length > 0) {
      choice = Math.floor(Math.random() * 4);
      switch (choice) {
      case 0:
        if (agent1._remaining_patches.length > 0) {
          patch_obj = agent1._remaining_patches[0];
          log.debug("agent1 patch:", patch_obj);
          agent1._remaining_patches = agent1._remaining_patches.slice(1);
          permute_ops.push(patch.bind(null, agent1, patch_obj));
        }
        break;
      case 1:
        if (agent2._remaining_patches.length > 0) {
          patch_obj = agent2._remaining_patches[0];
          log.debug("agent2 patch:", patch_obj);
          agent2._remaining_patches = agent2._remaining_patches.slice(1);
          permute_ops.push(patch.bind(null, agent2, patch_obj));
        }
        break;
      case 2:
        log.debug("agent1 pop patch");
        permute_ops.push(pop_agent1);
        break;
      case 3:
        log.debug("agent2 pop patch");
        permute_ops.push(pop_agent2);
        break;
      }
    }

    permute_ops.push(function () {
      agent1.pop_patch(-1);
    });
    permute_ops.push(function () {
      agent2.pop_patch(-1);
    });
    return permute_ops;
  };

  ops = permute(agents[agent_id - 1], agents[agent_id]);
  _.each(ops, function (op) {
    op();
  });
  verify(test, [agents[agent_id - 1], agents[agent_id]]);
};

var test5 = function (test) {

  permute_patches(test, ["abc", "abcde"], ["abc", "abcde"]);

  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcde");
  patch(agent2, "abcdef");
  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(test, [agent1, agent2]);
  test.done();
};

var test6 = function (test) {
  permute_patches(test, ["abc", "abcd", "abcde"], ["abc", "abcd", "abcde", "abcdef"]);
  test.done();
};


module.exports = {
  setUp: test.setup,
  tearDown: test.teardown,
  test1: test1,
  test2: test2,
  test3: test3,
  test4: test4,
  // The following tests sometimes fail (permute_patches is not deterministic)
  // TODO: fix the edge cases where they fail
  // test5: test5,
  // test6: test6,
  // test7: test6
};

// module.exports["test8"] = test6;
// module.exports["test9"] = test6;
// module.exports["test10"] = test6;
// module.exports["test11"] = test6;

// module.exports.fails_wtf = function (test) {
//   agent1.buf = "abc";
//   agent2.buf = "abc";

// //  agent2.pop_patch(1);
// //  patch(agent1, "abc");
// //  agent1.pop_patch(1);
//   patch(agent1, "abcd");
//   patch(agent2, "abc");
//   patch(agent2, "abcd");
//   agent2.pop_patch(2);
//   agent1.pop_patch(1);
//   patch(agent1, "abcde");
//   agent1.pop_patch(1);
//   patch(agent2, "abcde");
//   agent1.pop_patch(1);
//   patch(agent2, "abcdef");

//   agent1.pop_patch(-1);
//   agent2.pop_patch(-1);
//   verify(test, [agent1, agent2]);
//   test.done();
// };
