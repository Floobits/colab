"use strict";

const log = require("floorine");
const _ = require("lodash");

const mock = require("mock");
const test = require("test");

const patch = test.patch,
  verify = test.verify,
  agent1 = test.agent1,
  agent2 = test.agent2,
  agent_id = test.agent_id,
  r = test.r;


function test1(t) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcd");
  patch(agent1, "abcde");
  patch(agent2, "abcd");

  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(t, [agent1, agent2]);
  t.done();
}

function test2(t) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcd");
  patch(agent1, "abcde");
  patch(agent2, "abcf");

  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(t, [agent1, agent2]);
  t.done();
}

function test3(t) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcd");
  patch(agent1, "abcde");
  patch(agent2, "abcd");
  patch(agent2, "abcde");
  patch(agent2, "abcdef");

  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(t, [agent1, agent2]);
  t.done();
}

function test4(t) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent2, "abcdef");
  patch(agent1, "ab");
  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(t, [agent1, agent2]);
  t.done();
}

function permute_patches() {
  var args,
    t,
    agents = {},
    agents_patches,
    permute,
    ops;
  args = Array.prototype.slice.call(arguments);
  t = args[0];
  agents_patches = args.slice(1);

  _.each(agents_patches, function (agent_patches) {
    var agent;
    agent_id++;
    agent = new mock.FakeAgentHandler(r, agent_id);
    agent._patches = agent_patches;
    agents[agent_id] = agent;

    agent.on_room_load();
  });

  permute = function (a1, a2) {
    var permute_ops = [],
      choice,
      patch_obj,
      pop_agent1,
      pop_agent2;

    a1._remaining_patches = _.clone(a1._patches);
    a2._remaining_patches = _.clone(a2._patches);

    pop_agent1 = function () {
      a1.pop_patch(1);
    };
    pop_agent2 = function () {
      a2.pop_patch(1);
    };

    while (a1._remaining_patches.length > 0 || a2._remaining_patches.length > 0) {
      choice = Math.floor(Math.random() * 4);
      switch (choice) {
      case 0:
        if (a1._remaining_patches.length > 0) {
          patch_obj = a1._remaining_patches[0];
          log.debug("agent1 patch:", patch_obj);
          a1._remaining_patches = a1._remaining_patches.slice(1);
          permute_ops.push(patch.bind(null, a1, patch_obj));
        }
        break;
      case 1:
        if (a2._remaining_patches.length > 0) {
          patch_obj = a2._remaining_patches[0];
          log.debug("agent2 patch:", patch_obj);
          a2._remaining_patches = a2._remaining_patches.slice(1);
          permute_ops.push(patch.bind(null, a2, patch_obj));
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
      default:
        throw new Error("Unknown op! This should never happen!");
      }
    }

    permute_ops.push(function () {
      a1.pop_patch(-1);
    });
    permute_ops.push(function () {
      a2.pop_patch(-1);
    });
    return permute_ops;
  };

  ops = permute(agents[agent_id - 1], agents[agent_id]);
  _.each(ops, function (op) {
    op();
  });
  verify(t, [agents[agent_id - 1], agents[agent_id]]);
}

function test5(t) {
  permute_patches(t, ["abc", "abcde"], ["abc", "abcde"]);

  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "abcde");
  patch(agent2, "abcdef");
  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  verify(t, [agent1, agent2]);
  t.done();
}

function test6(t) {
  permute_patches(t, ["abc", "abcd", "abcde"], ["abc", "abcd", "abcde", "abcdef"]);
  t.done();
}


module.exports = {
  setUp: test.setup,
  test1: test1,
  test2: test2,
  test3: test3,
  test4: test4,
  // The following tests sometimes fail (permute_patches is not deterministic)
  // TODO: fix the edge cases where they fail
  test5: test5,
  test6: test6,
  test7: test6,
  tearDown: test.teardown,
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
