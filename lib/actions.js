/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var flux = require("flukes");

var Conn = flux.createActions({
  end: function (conn) {
    return conn;
  },
  handler: function (conn_id, handler) {
    return [conn_id, handler];
  }
});

var Room = flux.createActions({
});

module.exports = {
  conn: new Conn(),
  room: new Room()
};
