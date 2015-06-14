"use strict";

const MSG = function (agent, msg) {
  var self = this;

  if (arguments.length === 1) {
    // agent arg is actually a db object
    return self.from_db(agent);
  }

  self.user_id = agent.id;
  self.username = agent.username;
  self.time = Date.now() / 1000;
  self.data = msg;
};

MSG.prototype.to_json = function () {
  var self = this,
    obj;

  obj = {
    username: self.username,
    time: self.time,
    data: self.data
  };

  if (self.user_id) {
    obj.user_id = self.user_id;
  }

  return obj;
};

module.exports = MSG;
