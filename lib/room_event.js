"use strict";

const util = require("util");

const _ = require("lodash");


const RoomEvent = function (id, name, data) {
  const self = this;
  if (arguments.length === 1) {
    self.from_json(id);
    return;
  }

  self.id = id;
  self.name = name;
  self.data = data;

  if (!_.isObject(self.data)) {
    throw new Error(util.format("%s data is not an object!", self.toString()));
  }
};

RoomEvent.prototype.toString = function () {
  return util.format("%s:%s", this.id, this.name);
};

RoomEvent.prototype.from_json = function (evt) {
  const self = this;

  self.id = evt.id;
  self.name = evt.name;
  self.data = evt.data;
  if (!_.isObject(evt.data)) {
    throw new Error(util.format("%s data is not an object!", self.toString()));
  }
};

RoomEvent.prototype.to_db = function () {
  const self = this;
  const data = self.data || {};

  return {
    id: self.id,
    name: self.name,
    data: data,
  };
};

RoomEvent.prototype.to_json = function () {
  const self = this;
  const data = self.data || {};

  if (self.name !== "msg") {
    return self.to_db();
  }

  // Lame hack but whatever
  return {
    name: self.name,
    time: data.time,
    username: data.username,
    data: data.data,
  };
};

module.exports = RoomEvent;
