var util = require('util');
var events = require('events');

var _ = require('underscore');

var Room = function(name, agent) {
  var self = this;
  self.name = name;
  self.owner = agent.username;
  self.agents = {};
  self.bufs = {};

  events.EventEmitter.call(self);
};

util.inherits(Room, events.EventEmitter);

exports.add_agent = function(name, agent) {
  var room = agent.server.rooms[name];

  if (room === undefined) {
    room = new Room(name, agent);
    agent.server.rooms[name] = room;
  }

  room.agents[agent.id] = agent;
  agent.bufs = room.bufs;
  room.on('dmp', agent.on_dmp.bind(agent));

  return room;
};
