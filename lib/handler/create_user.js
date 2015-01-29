/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var utils = require("../utils");
var api_client = require("../api_client");
var BaseAgentHandler = require("./base");

var CreateUserHandler = function () {
  BaseAgentHandler.apply(this, arguments);
};

util.inherits(CreateUserHandler, BaseAgentHandler);

CreateUserHandler.prototype.create = function (data) {
  var self = this;

  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = setTimeout(function () {
    self.disconnect("Timed out waiting for user creation to finish.");
  }, 20 * 1000);
  utils.set_state(self, self.CONN_STATES.JOINED);
  log.log("%s creating user %s...", self.toString(), data.username);

  api_client.user_create(data.username, function (err, user_info) {
    if (err) {
      self.error(null, err, true);
      log.warn("%s error creating user %s: %s", self.toString(), data.username, err);
    } else {
      self.write("create_user", null, user_info);
      log.log("%s created user %s", self.toString(), user_info.username);
    }
    return self.destroy();
  });
};

module.exports = CreateUserHandler;
