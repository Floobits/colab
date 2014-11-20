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
  // ▪️    LOG 2014-11-20 12:57:47 PST agent1 sending patch from abc to abcd
  // ▫️  DEBUG 2014-11-20 12:57:47 PST applying patch @@ -1,3 +1,4 @@
  //  abc
  // +d
  //  to buf

  patch(agent1, "abcde");
  // ▪️    LOG 2014-11-20 12:57:47 PST agent1 sending patch from abcd to abcde
  // ▫️  DEBUG 2014-11-20 12:57:47 PST applying patch @@ -1,4 +1,5 @@
  //  abcd
  // +e
  //  to buf

  patch(agent2, "abcd");
  //     LOG 2014-11-20 12:57:47 PST agent2 sending patch from abc to abcd
  // ▪️    LOG 2014-11-20 12:57:47 PST md5_before doesn't match. BE WARY!
  // ▫️  DEBUG 2014-11-20 12:57:47 PST applying patch 1 @@ -1,3 +1,4 @@
  //  abc
  // +d
  //  to agent2 text
  // ▫️  DEBUG 2014-11-20 12:57:47 PST agent2 text is <Buffer 61 62 63 64>
  // ▫️  DEBUG 2014-11-20 12:57:47 PST agent2 text matches current state. entering time machine.
  // ▫️  DEBUG 2014-11-20 12:57:47 PST found matching previous md5
  // ▫️  DEBUG 2014-11-20 12:57:47 PST applying patch 2  @@ -1,3 +1,4 @@
  //  abc
  // +d
  //  to <Buffer 61 62 63 64> text
  // ▫️  DEBUG 2014-11-20 12:57:47 PST agent2 text is <Buffer 61 62 63 64 64>
  // ▫️  DEBUG 2014-11-20 12:57:47 PST found matching previous md5
  // ▫️  DEBUG 2014-11-20 12:57:47 PST applying patch 2  @@ -1,4 +1,5 @@
  //  abcd
  // +e
  //  to <Buffer 61 62 63 64 64> text
  // ▪️    LOG 2014-11-20 12:57:47 PST undo patch: @@ -1,6 +1,5 @@
  //  abcd
  // -d
  //  e
  // ▪️    LOG 2014-11-20 12:57:47 PST 2 'patch'
  // ▪️    LOG 2014-11-20 12:57:47 PST buf state is <Buffer 61 62 63 64 65>

  patch(agent2, "abcde");
  // ▪️    LOG 2014-11-20 12:57:47 PST agent2 sending patch from abcd to abcde
  // ▪️    LOG 2014-11-20 12:57:47 PST md5_before doesn't match. BE WARY!
  // ▪️    LOG 2014-11-20 12:57:47 PST md5_after matches current state ab56b4d92b40713acc5af89985d4b786 patch text: @@ -1,4 +1,5 @@
  //  abcd
  // +e

  // This is the patch agent2 sent
  // ▫️  DEBUG 2014-11-20 12:57:47 PST applying patch 1 @@ -1,4 +1,5 @@
  //  abcd
  // +e
  //  to agent2 text
  // ▫️  DEBUG 2014-11-20 12:57:47 PST agent2 text is <Buffer 61 62 63 64 65>
  // ▫️  DEBUG 2014-11-20 12:57:47 PST found matching previous md5


  // This is the patch agent1 sent
  // ▫️  DEBUG 2014-11-20 12:57:47 PST applying patch 2  @@ -1,4 +1,5 @@
  //  abcd
  // +e
  //  to <Buffer 61 62 63 64 65> text
  // ▫️  DEBUG 2014-11-20 12:57:47 PST applying patch @@ -1,5 +1,6 @@
  //  abcde
  // +e
  //  to buf
  // ▫️  DEBUG 2014-11-20 12:57:47 PST Buffer 0 -1 fake_owner/fake_room/test.txt md5 94af155370ff640425a75c743ade5787 length 6 updated. md5 was ab56b4d92b40713acc5af89985d4b786 now 94af155370ff640425a75c743ade5787
  // ▪️    LOG 2014-11-20 12:57:47 PST 1 'patch'
  // ▪️    LOG 2014-11-20 12:57:47 PST buf state is <Buffer 61 62 63 64 65 65>

  patch(agent2, "abcdef");

  // ▪️    LOG 2014-11-20 12:57:47 PST agent2 sending patch from abcde to abcdef
  // ▪️    LOG 2014-11-20 12:57:47 PST md5_before doesn't match. BE WARY!
  // ▫️  DEBUG 2014-11-20 12:57:47 PST applying patch 1 @@ -1,5 +1,6 @@
  //  abcde
  // +f
  //  to agent2 text
  // ▫️  DEBUG 2014-11-20 12:57:47 PST agent2 text is <Buffer 61 62 63 64 65 66>
  // ▫️  DEBUG 2014-11-20 12:57:47 PST found matching previous md5
  // ▫️  DEBUG 2014-11-20 12:57:47 PST applying patch 2  @@ -1,5 +1,6 @@
  //  abcde
  // +e
  //  to <Buffer 61 62 63 64 65 66> text
  // ▫️  DEBUG 2014-11-20 12:57:47 PST applying patch @@ -1,6 +1,7 @@
  //  abcde
  // +f
  //  e
  //  to buf

  agent2.pop_patch(-1);
  agent1.pop_patch(-1);

  // ▫️  DEBUG 2014-11-20 12:57:47 PST Buffer 0 -1 fake_owner/fake_room/test.txt md5 bcf04267b681e00357374109284df439 length 7 updated. md5 was 94af155370ff640425a75c743ade5787 now bcf04267b681e00357374109284df439
  // ▪️    LOG 2014-11-20 12:57:47 PST 1 'patch'
  // ▪️    LOG 2014-11-20 12:57:47 PST buf state is <Buffer 61 62 63 64 65 66 65>
  // 🔥  ERROR 2014-11-20 12:57:47 PST Patch wasn't applied! [ 'abcdef', [ false ] ] 900150983cd24fb0d6963f7d28e17f72 e2fc714c4727ee9395f324cd2e7f331f
  // ▪️    LOG 2014-11-20 12:57:47 PST agent2 patched from abcdef to abcdefe
  // ▪️    LOG 2014-11-20 12:57:47 PST agent2 patched from abcdefe to abcde
  // ▪️    LOG 2014-11-20 12:57:47 PST agent1 patched from abcde to abcdee
  // ▪️    LOG 2014-11-20 12:57:47 PST agent1 patched from abcdee to abcdefe
  // ▪️    LOG 2014-11-20 12:57:47 PST buf is <Buffer 61 62 63 64 65 66 65>

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
    var agent = new mock.FakeAgentConnection(r, agent_id);
    agent._patches = agent_patches;
    agents[agent_id] = agent;
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

var test4 = function (test) {

  permute_patches(test, ["abc", "abcde"], ["abc", "abcde"]);

  // agent1.buf = "abc";
  // agent2.buf = "abc";

  // patch(agent1, "abcde");
  // patch(agent2, "abcdef");
  // agent2.pop_patch(-1);
  // agent1.pop_patch(-1);

  // verify(test, [agent1, agent2]);
  test.done();
};

var test5 = function (test) {
  agent1.buf = "abc";
  agent2.buf = "abc";

  patch(agent1, "ab");
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
  // test1: test1,
  // test2: test2,
  test3: test3,
  // test4: test4,
  // test5: test5,
  // test6: test6,
  // test7: test6
};

// module.exports["test8"] = test6;
// module.exports["test9"] = test6;
// module.exports["test10"] = test6;
// module.exports["test11"] = test6;

// module.exports.afsdasdasf = function (test) {
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
