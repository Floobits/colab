/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var _ = require("lodash");


var RoomEvent = function (id, name, data) {
  var self = this;

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
  var self = this;

  self.id = evt.id;
  self.name = evt.name;
  self.data = evt.data;
  if (!_.isObject(evt.data)) {
    throw new Error(util.format("%s data is not an object!", self.toString()));
  }
};

RoomEvent.prototype.to_db = function () {
  var self = this,
    data = self.data || {};

  return {
    id: self.id,
    name: self.name,
    data: data,
  };
};

RoomEvent.prototype.to_json = function () {
  var self = this,
    data = self.data || {};

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
