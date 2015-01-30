/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");
var log = require("floorine");
var _ = require("lodash");

var FloobitsProtocol = require("./floobits");
var MasterHandler = require("../handler/master");


var MasterProtocol = function () {
  FloobitsProtocol.apply(this, arguments);
  this.req_id = 0;
  this.install_handler(MasterHandler, this);
};

util.inherits(MasterProtocol, FloobitsProtocol);

MasterProtocol.prototype.write = function (json, cb) {
  var self = this,
    str,
    req_id = ++self.req_id;

  json.req_id = req_id;
  self.outstanding_reqs[req_id] = json.name;

  str = JSON.stringify(json);

  // User image stuff is really long
  if (json.name !== "datamsg" || (json.data && json.data.name !== "user_image")) {
    log.debug("to %s - %s: %s", self.name, self.id, str);
  }

  try {
    self.conn.write(str);
    self.conn.write("\n", cb);
  } catch (e) {
    log.error("error writing to client %s: %s. disconnecting.", self.toString(), e);
    // TODO: emit or something
    self.destroy();
    return cb && cb();
  }
};

MasterProtocol.prototype.handle_msg_ = function (msg) {
  var self = this, res_id;

  try {
    msg = JSON.parse(msg);
  } catch (e) {
    log.error("couldn't parse json:", msg, "error:", e);
    return self.disconnect();
  }

  if (_.has(msg, "res_id")) {
    // Make sure res_id is an integer
    if (msg.res_id % 1 === 0) {
      res_id = msg.res_id;
      delete self.outstanding_reqs[res_id];
    } else {
      log.error("%s bad res_id: %s", self.toString(), msg.res_id);
      return self.disconnect();
    }
  }

  if (!self.handler) {
    log.error("Got a message but no handler is set!");
    return self.disconnect();
  }

  if (msg.name === "ack") {
    return;
  }

  return self.handler.handle(msg);
};

module.exports = MasterProtocol;
