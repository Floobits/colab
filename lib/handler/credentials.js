/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var log = require("floorine");

var utils = require("../utils");
var BaseAgentHandler = require("./base");

var PENDING_CREDS = {};

var send_credentials = function (supplier, requester, credentials) {
  if (supplier.remote_address !== requester.remote_address) {
    log.error("IP addresses don't match! requester:", requester.remote_address, "supplier:", supplier.remote_address);
  }

  requester.write("credentials", null, {credentials: credentials}, requester.destroy.bind(requester));
  supplier.write("success", null, {
    requester: {
      client: requester.client,
      platform: requester.platform,
      version: requester.version
    }
  }, supplier.destroy.bind(supplier));
  log.log("%s sent credentials to %s", supplier.toString(), requester.toString());
};

var CredentialsHandler = function () {
  BaseAgentHandler.apply(this, arguments);
};

util.inherits(CredentialsHandler, BaseAgentHandler);

CredentialsHandler.prototype.name = "credentializer";

CredentialsHandler.prototype.supply = function (data) {
  var self = this,
    creds;

  self.handle_forwarded_options(data);

  log.log("%s supply credentials for %s", self.toString(), data.credentials && data.credentials.username);
  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = setTimeout(function () {
    delete PENDING_CREDS[data.token];
    self.disconnect("Timed out waiting for native editor to request credentials.");
  }, 90 * 1000);
  utils.set_state(self, self.CONN_STATES.JOINED);

  creds = PENDING_CREDS[data.token];
  if (creds && creds.requester) {
    send_credentials(self, creds.requester, data.credentials);
    delete PENDING_CREDS[data.token];
  } else {
    PENDING_CREDS[data.token] = {
      supplier: self,
      credentials: data.credentials
    };
  }
};

CredentialsHandler.prototype.request = function (data) {
  var self = this,
    creds;

  self.handle_forwarded_options(data);

  log.log("%s request credentials for %s %s %s", self.toString(), data.client, data.platform, data.version);
  clearTimeout(self.auth_timeout_id);
  self.auth_timeout_id = setTimeout(function () {
    delete PENDING_CREDS[data.token];
    self.disconnect("Timed out waiting for browser to supply credentials.");
  }, 90 * 1000);
  utils.set_state(self, self.CONN_STATES.JOINED);

  self.client = data.client;
  self.platform = data.platform;
  self.version = data.version;

  creds = PENDING_CREDS[data.token];
  if (creds && creds.supplier) {
    send_credentials(creds.supplier, self, creds.credentials);
    delete PENDING_CREDS[data.token];
  } else {
    PENDING_CREDS[data.token] = {
      requester: self
    };
  }
};

module.exports = CredentialsHandler;
