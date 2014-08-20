/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var MSG = function (agent, msg) {
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

MSG.prototype.from_db = function (db_obj) {
  var self = this;

  self.username = db_obj.username;
  self.time = db_obj.time;
  self.data = db_obj.data;
};

MSG.prototype.to_db = function () {
  var self = this;

  return {
    name: "msg",
    username: self.username,
    time: self.time,
    data: self.data,
  };
};

module.exports = MSG;
