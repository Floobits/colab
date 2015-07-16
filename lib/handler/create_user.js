"use strict";

const util = require("util");

const log = require("floorine");

const api_client = require("../api_client");
const BaseAgentHandler = require("./base");
const utils = require("../utils");

const CreateUserHandler = function () {
  BaseAgentHandler.apply(this, arguments);
};

util.inherits(CreateUserHandler, BaseAgentHandler);

CreateUserHandler.prototype.name = "new user";

CreateUserHandler.prototype.create = function (data) {
  const self = this;

  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = setTimeout(function () {
    self.disconnect("Timed out waiting for user creation to finish.");
  }, 20 * 1000);
  utils.set_state(self, self.CONN_STATES.JOINED);
  log.log("%s creating user %s...", self.toString(), data.username);

  api_client.user_create(data, function (err, user_info) {
    if (err) {
      self.error(null, err, true, self.destroy.bind(self));
      log.warn("%s error creating user %s: %s", self.toString(), data.username, err);
    } else {
      self.write("create_user", null, user_info, self.destroy.bind(self));
      log.log("%s created user %s", self.toString(), user_info.username);
    }
  });
};

module.exports = CreateUserHandler;
