/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var tls = require("tls");
var util = require("util");

var log = require("floorine");
var _ = require("lodash");

var actions = require("../actions");
var FloobitsProtocol = require("./floobits");
var MasterHandler = require("../handler/master");


var MasterProtocol = function (id, options) {
  FloobitsProtocol.call(this, id);
  this.options = options;
};

util.inherits(MasterProtocol, FloobitsProtocol);


MasterProtocol.prototype.on_close = function () {
  this.emit("close");
  actions.conn.end(this);
};

MasterProtocol.prototype.connect = function (server, cb) {
  var self = this,
    cleartext_stream;

  cleartext_stream = tls.connect(self.options, function () {
    self.init_conn(cleartext_stream, true);
    self.install_handler(MasterHandler, self);
    self.handler.auth(server);
    return cb();
  });
  cleartext_stream.setEncoding("utf8");
};

module.exports = MasterProtocol;
