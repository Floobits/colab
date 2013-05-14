var events = require("events");
var util = require("util");


var ColabTerm = function (room, id, owner, name) {
  var self = this;
  self.room = room;
  self.id = id;
  self.owner = owner;
  self.name = name;
};

util.inherits(ColabTerm, events.EventEmitter);

ColabTerm.prototype.toString = function() {
  var self = this;
  return util.format("Terminal id %s name %s room %s owner %s", self.id, self.name, self.room.toString(), self.owner.toString());
};

ColabTerm.prototype.to_json = function() {
  var self = this;
  return {
    "id": self.id,
    "name": self.name,
    "owner": self.owner.id
  };
};

ColabTerm.prototype.stdin = function(data) {
  var self = this;

  // TODO
};

ColabTerm.prototype.stdout = function(data) {
  var self = this;

  // TODO
};

module.exports = ColabTerm;
