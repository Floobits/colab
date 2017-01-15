"use strict";
/* eslint-disable no-unused-vars */

const log = require("floorine");
const _ = require("lodash");

const test = require("./test");

let patch = test.patch,
  verify = test.verify,
  agents = test.agents;


function test1(t) {
  patch(agents[0], "abcd");
  patch(agents[0], "abcde");
  patch(agents[1], "abcd");

  agents[1].pop_patch(-1);
  agents[0].pop_patch(-1);

  verify(t, agents);
  t.done();
}

function test2(t) {
  patch(agents[0], "abcd");
  patch(agents[0], "abcde");
  patch(agents[1], "abcf");

  agents[1].pop_patch(-1);
  agents[0].pop_patch(-1);

  verify(t, agents);
  t.done();
}

function test3(t) {
  patch(agents[0], "abcd");
  patch(agents[0], "abcde");
  patch(agents[1], "abcd");
  patch(agents[1], "abcde");
  patch(agents[1], "abcdef");

  agents[1].pop_patch(-1);
  agents[0].pop_patch(-1);

  verify(t, agents);
  t.done();
}

function test4(t) {
  patch(agents[1], "abcdef");
  patch(agents[0], "ab");
  agents[1].pop_patch(-1);
  agents[0].pop_patch(-1);

  verify(t, agents);
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

  _.each(agents_patches, function (agent_patches, i) {
    const agent = test.agents[i];
    agent._patches = agent_patches;
    agents[i] = agent;
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
            log.debug("agents[0] patch:", patch_obj);
            a1._remaining_patches = a1._remaining_patches.slice(1);
            permute_ops.push(patch.bind(null, a1, patch_obj));
          }
          break;
        case 1:
          if (a2._remaining_patches.length > 0) {
            patch_obj = a2._remaining_patches[0];
            log.debug("agents[1] patch:", patch_obj);
            a2._remaining_patches = a2._remaining_patches.slice(1);
            permute_ops.push(patch.bind(null, a2, patch_obj));
          }
          break;
        case 2:
          log.debug("agents[0] pop patch");
          permute_ops.push(pop_agent1);
          break;
        case 3:
          log.debug("agents[1] pop patch");
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

  ops = permute(agents[0], agents[1]);
  _.each(ops, function (op) {
    op();
  });
  verify(t, agents);
}

function test5(t) {
  permute_patches(t, ["abc", "abcde"], ["abc", "abcde"]);

  patch(agents[0], "abcde");
  patch(agents[1], "abcdef");
  agents[1].pop_patch(-1);
  agents[0].pop_patch(-1);

  verify(t, agents);
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
  // test3: test3,
  test4: test4,
  // The following tests sometimes fail (permute_patches is not deterministic)
  // TODO: fix the edge cases where they fail
  // test5: test5,
  // test6: test6,
  // test7: test6,
  tearDown: test.teardown,
};

// module.exports["test8"] = test6;
// module.exports["test9"] = test6;
// module.exports["test10"] = test6;
// module.exports["test11"] = test6;

// module.exports.fails_wtf = function (test) {

// //  agents[1].pop_patch(1);
// //  patch(agents[0], "abc");
// //  agents[0].pop_patch(1);
//   patch(agents[0], "abcd");
//   patch(agents[1], "abc");
//   patch(agents[1], "abcd");
//   agents[1].pop_patch(2);
//   agents[0].pop_patch(1);
//   patch(agents[0], "abcde");
//   agents[0].pop_patch(1);
//   patch(agents[1], "abcde");
//   agents[0].pop_patch(1);
//   patch(agents[1], "abcdef");

//   agents[0].pop_patch(-1);
//   agents[1].pop_patch(-1);
//   verify(test, agents);
//   test.done();
// };
/* eslint-enable no-unused-vars */
