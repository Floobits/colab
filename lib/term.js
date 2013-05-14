var util = require("util");

var log = require("./log");


var ColabTerm = function (room, id, owner, name) {
  var self = this;
  self.room = room;
  self.id = id;
  self.owner = owner;
  self.name = name;

  self.owner.on("on_conn_end", function () {
    self.room.delete_term(self);
  });
};

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

ColabTerm.prototype.stdin = function(agent, data) {
  var self = this;

  log.debug(self.toString(), "agent", agent.id, "user", agent.username, "sent to stdin:", data);

  // Send data to terminal owner
  self.owner.emit("dmp", agent, "term_stdin", {
    "id": self.id,
    "user_id": agent.id,
    "username": agent.username,
    "data": data
  });
};

ColabTerm.prototype.stdout = function(data) {
  var self = this;

  log.debug(self.toString(), "user", self.owner.username, "sent to stdout:", data);

  // Send stdout to everyone but the owner (he's got echo on)
  self.room.emit("dmp", self.owner, "term_stdout", {
    "id": self.id,
    "data": data
  });
};

module.exports = ColabTerm;
