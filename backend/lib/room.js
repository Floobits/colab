
var util = require('util');
var events = require('events');

var _ = require('underscore');

var __ROOMS = {};

var Room = function(name, owner, permissions){
  var self = this;
  // for later
  self.permissions = permissions;
  self.name = name;
  self.owner = owner;
  self.rooms[self.name] = self;
  events.EventEmitter.call(self);
};

Room.prototype.own = function(agent){
  var self = this;
  return self.owner && self.owner === agent;
};

util.inherits(Room, events.EventEmitter);

exports.create = function(name, agent, permissions){
  var room = __ROOMS[name];

  if (room){
    // the room exists, so attach the agent
    room.listen('dmp', agent.on_dmp.bind(agent));
    // NOTE: this really does return the other room, even
    // called with new
    return room;
  }
  room = new Room(name, agent, permissions);
  __ROOMS[name] = room;

  return room;
};
