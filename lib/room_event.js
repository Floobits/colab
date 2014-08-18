/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var events = require("events");
var path = require("path");
var url = require("url");
var util = require("util");

var _ = require("lodash");
var async = require("async");
var fs = require("fs-extra");
var log = require("floorine");


var RoomEvent = function (id, name, data) {
  var self = this;

  if (arguments.length === 1) {
    self.from_json(id);
    return;
  }

  self.id = id;
  self.name = name;
  self.data = data;
};

RoomEvent.prototype.from_json = function (evt) {
  var self = this;

  self.id = evt.id;
  self.name = evt.name;
  self.data = evt.data;
};

RoomEvent.prototype.to_json = function () {
  var self = this,
    data = self.data;

  data.name = self.name;

  return data;
};

module.exports = RoomEvent;
