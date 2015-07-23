"use strict";

const util = require("util");

const log = require("floorine");
const _ = require("lodash");


const ColabTerm = function (room, id, owner, name, size) {
  const self = this;
  self.room = room;
  self.id = id;
  self.owner = owner;
  self.name = name;
  self.size = size;
  self.broadcast = undefined;
};

ColabTerm.prototype.toString = function () {
  const self = this;
  return util.format("Terminal id %s name %s workspace %s owner %s", self.id, self.name, self.room.toString(), self.owner.toString());
};

ColabTerm.prototype.to_json = function () {
  const self = this;

  return {
    id: self.id,
    term_name: self.name,
    owner: self.owner.id,
    size: self.size
  };
};

ColabTerm.prototype.update = function (agent, req_id, data) {
  const self = this;

  log.debug("updated term info:", data);
  if (data.size && _.isArray(data.size)) {
    self.size = data.size.slice(0, 2);
  } else {
    return log.log("Agent %s sent stupid data. Data: %s", agent.toString(), JSON.dumps(data));
  }
  self.room.broadcast("update_term", agent, req_id, {
    id: self.id,
    user_id: agent.id,
    username: agent.username,
    size: self.size
  });
};

ColabTerm.prototype.stdin = function (agent, req_id, data, summon) {
  const self = this;

  log.debug("%s user %s send %s chars to stdin", self.toString(), agent.username, data.length);
  log.debug(self.toString(), "agent", agent.id, "user", agent.username, "sent", data.length, "chars to stdin");

  if (agent.id !== self.owner.id) {
    // Send data only to terminal owner
    self.owner.write("term_stdin", null, {
      id: self.id,
      user_id: agent.id,
      username: agent.username,
      summon: !!summon,
      data: data
    });
  }

  // Send an event to everyone so the terminal can be focused in follow mode
  self.room.broadcast("term_stdin", agent, req_id, {
    id: self.id,
    user_id: agent.id,
    username: agent.username,
    summon: !!summon,
    data: "",
  }, self.broadcast);
};

ColabTerm.prototype.stdout = function (req_id, data) {
  const self = this;

  log.debug("%s user %s send %s chars to stdout", self.toString(), self.owner.username, data.length);

  // Send stdout to everyone but the owner (he's got echo on)
  self.room.broadcast("term_stdout", self.owner, req_id, {
    id: self.id,
    data: data
  }, self.broadcast);
};

module.exports = ColabTerm;
