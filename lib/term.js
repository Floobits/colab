/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var log = require("floorine");
var _ = require("lodash");


var ColabTerm = function (room, id, owner, name, size) {
  var self = this;
  self.room = room;
  self.id = id;
  self.owner = owner;
  self.name = name;
  self.size = size;

  self.owner.on("on_conn_end", function () {
    self.room.delete_term(self.owner, self.id);
  });
};

ColabTerm.prototype.toString = function () {
  var self = this;
  return util.format("Terminal id %s name %s workspace %s owner %s", self.id, self.name, self.room.toString(), self.owner.toString());
};

ColabTerm.prototype.to_json = function () {
  var self = this;

  return {
    id: self.id,
    term_name: self.name,
    owner: self.owner.id,
    size: self.size
  };
};

ColabTerm.prototype.update = function (agent, data) {
  var self = this;

  log.debug("updated term info:", data);
  if (data.size && _.isArray(data.size)) {
    self.size = data.size.slice(0, 2);
  } else {
    return log.log(util.format("Agent %s sent stupid data. Data: %s", agent.toString(), JSON.dumps(data)));
  }
  self.room.broadcast("update_term", null, agent, {
    id: self.id,
    user_id: agent.id,
    username: agent.username,
    size: self.size
  });
};

ColabTerm.prototype.stdin = function (agent, data) {
  var self = this;

  log.debug(self.toString(), "agent", agent.id, "user", agent.username, "sent", data.length, "chars to stdin");

  if (agent.id !== self.owner.id) {
    // Send data to terminal owner
    self.owner.on_dmp(agent, "term_stdin", {
      id: self.id,
      user_id: agent.id,
      username: agent.username,
      data: data
    });
  }

  self.room.broadcast("term_stdin", null, agent, {
    id: self.id,
    user_id: agent.id,
    username: agent.username,
    data: ""
  });
};

ColabTerm.prototype.stdout = function (data) {
  var self = this;

  log.debug(self.toString(), "user", self.owner.username, "sent ", data.length, " chars to stdout");

  // Send stdout to everyone but the owner (he's got echo on)
  self.room.broadcast("term_stdout", null, self.owner, {
    id: self.id,
    data: data
  });
};

module.exports = ColabTerm;
