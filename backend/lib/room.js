var util = require('util');
var events = require('events');

var _ = require('underscore');

var ColabBuffer = require('./buffer');
var log = require('./log');


var Room = function (name, agent) {
  var self = this;
  self.name = name;
  self.owner = agent.username;
  self.agents = {};
  self.bufs = {};
  // directory in json :)
  self.tree = {};
  self.cur_fid = 0;

  events.EventEmitter.call(self);
};

util.inherits(Room, events.EventEmitter);

Room.prototype.get_buf = function (id) {
  var self = this;
  return self.bufs[id];
};

Room.prototype.create_buf = function (path){
  log.debug("buf for path", path, "doesn't exist. creating...");

  var sub_tree = self.tree;
  var chunks = path.split("/");
  var chunk;

  // GOOD INTERVIEW QUESTION
  for(var i=0; i<chunks.length; i++){
    chunk = chunks[i];

    if (i == chunks.length-1 && sub_tree[chunk] !== undefined){
      log.warn('trying to stomp path', path);
      return;
    }
    sub_tree = sub_tree[chunk];
    if (sub_tree === undefined){
      break;
    }
  }

  buf = new ColabBuffer(self, path, ++self.cur_fid);
  self.bufs[buf.id] = buf;
  sub_tree = self.tree;
  _.each(chunks, function(chunk){
    if (!sub_tree[chunk]){
      sub_tree[chunk] = {};
    }
    sub_tree = sub_tree[chunk];
  });
  sub_tree = buf.id;

  return buf;
};

Room.prototype.to_json = function () {
  var self = this;
  var room_info = {
    "bufs": _.map(self.bufs, function(buf, path){
      return buf.to_json();
    }),
    "owner": self.owner,
    "users": _.map(self.agents, function (agent, id) {
      return agent.username;
    })
  };
  return room_info;
};

Room.prototype.buf_paths = function () {
  var self = this;
  var buf_paths = {};
  _.each(self.bufs, function (buf, path) {
    buf_paths[path] = {
      "md5": buf._md5
    };
  });
  return buf_paths;
};


exports.add_agent = function (name, agent) {
  var room = agent.server.rooms[name];

  if (room === undefined) {
    room = new Room(name, agent);
    agent.server.rooms[name] = room;
  }

  room.agents[agent.id] = agent;
  agent.bufs = room.bufs;
  room.on('dmp', agent.dmp_listener);

  return room;
};
