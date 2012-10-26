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

  events.EventEmitter.call(self);
};

util.inherits(Room, events.EventEmitter);

Room.prototype.get_buf = function (path) {
  var self = this;
  var buf = self.bufs[path];
  if (buf === undefined) {
    log.debug("buf for path", path, "doesn't exist. creating...");
    log.debug("bufs:", self.bufs);
    buf = new ColabBuffer(self, path);
    self.bufs[path] = buf;
  }
  return buf;
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
