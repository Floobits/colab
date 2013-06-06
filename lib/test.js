var events = require("events");
var fs = require("fs");
var path = require("path");
var util = require("util");

var async = require("async");
var _ = require("underscore");

var agent = require("./agent");
var ColabBuffer = require("./buffer");
var log = require("./log");
var room = require("./room");
var utils = require("./utils");


var agent1,
  agent2,
  r,
  buf,
  agent_id = 1;

var MockConn = function (agent) {
  var self = this;
  events.EventEmitter.call(self);
  self.agent = agent;
};

util.inherits(MockConn, events.EventEmitter);

MockConn.prototype.write = function (name, data) {
  var self = this;
  console.log(self.agent.toString(), "name:", name, "data:", JSON.stringify(data, null, 2));
};


var FakeAgentConnection = function (r) {
  var self = this,
    conn = new MockConn(self),
    room_info;

  agent.AgentConnection.call(self, agent_id++, conn, null);

  clearTimeout(self.auth_timeout_id)
  self.auth_timeout_id = null;
  self.username = self.toString();
  self.secret = "aoeuidhtns";
  self.client = "FAKE";
  self.version = "0.02";//agent.SUPPORTED_VERSIONS.slice(-1)[0];
  self.platform = "FAKE_PLATFORM";
  self.authenticated = true;
  self.user_id = -1;
  self.allowed_actions = [];
  _.each(utils.db_perms_mapping, function (perms, codename) {
    self.allowed_actions = self.allowed_actions.concat(perms);
  });
  self.allowed_actions = _.uniq(self.allowed_actions);

  self.room = r;
  r.agents[self.id] = self;
  self.bufs = r.bufs;

  room_info = self.room.to_json();
  // add_agent munges agent.allowed_actions :/
  room_info.perms = self.allowed_actions;

  self.write("room_info", room_info);

  r.on("dmp", self.dmp_listener);
  r.emit("dmp", self, "join", {
    "client": self.client,
    "platform": self.platform,
    "user_id": self.id,
    "username": self.username
  });
};

util.inherits(FakeAgentConnection, agent.AgentConnection);

FakeAgentConnection.prototype.toString = function() {
  var self = this;
  return util.format("agent%s", self.id);
};

FakeAgentConnection.prototype.write = function (name, data) {
  var self = this;
  self.conn.write(name, data);
};

r = new room.Room(-1, "fake_room", "fake_owner", {
  cur_fid: 0,
  max_size: 2147483647,
  require_ssl: false
});

ColabBuffer.prototype.save = function (create, cb) {
  console.log("lolz saving");
  cb();
};

var buf = new ColabBuffer(r, 1, "test.txt", "abc", undefined, true);
r.bufs[buf.id] = buf;
r.tree_add_buf(buf);

agent1 = new FakeAgentConnection(r);
agent2 = new FakeAgentConnection(r);
