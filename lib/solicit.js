/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var api_client = require("./api_client");
var perms = require("./perms");


var SOLICIT_STATES = {
  CREATED: 1,
  BIDDED: 2,
  DELETED: 3,
  HIRED: 4,
  CANCELED: 5,
  COMPLETED: 6,
};

var SOLICIT_STATES_REVERSE = _.invert(SOLICIT_STATES);

var Solicitation = function (agent, data) {
  this.state = SOLICIT_STATES.CREATED;
  this.creator = agent;
  this.contractors = {};

  this.id = null;
  this.path = data.path;
  this.preferred_contractor = data.preferred_contractor;
  this.description = data.description;
};

Solicitation.prototype.to_json = function (action) {
  var data = {
    action: action,
    state: SOLICIT_STATES_REVERSE[this.state],
    creator: this.creator.username,
    contractors: _.mapValues(this.contractors, function (c) {
      return {
        rate: c.rate,
        selected: c.selected,
      };
    }),
    id: this.id,
    path: this.path,
    preferred_contractor: this.preferred_contractor,
    description: this.description
  };
  return data;
};

Solicitation.prototype.toString = function () {
  return util.format("%s created by %s for %s", this.id, this.creator.toString(), this.path);
};

Solicitation.prototype.on_create = function (agent, data, cb) {
  var self = this;
  log.debug("%s %s solicitation %s", agent.toString(), data.action, this.toString());

  api_client.solicitation_create({
    path: self.path,
    preferred_contractor: self.preferred_contractor,
    description: self.description,
    user: self.creator.username,
    state: SOLICIT_STATES_REVERSE[self.state]
  }, function (err, result) {
    self.id = result.id;
    cb(err, result);
  });
};

Solicitation.prototype.on_bid = function (agent, data, cb) {
  if (!_.contains([SOLICIT_STATES.CREATED, SOLICIT_STATES.BIDDED], this.state)) {
    throw new Error(util.format("Cannot bid! Solicitation is already in state %s",
      SOLICIT_STATES_REVERSE[this.state]));
  }

  this.contractors[agent.username] = {
    agent: agent,
    rate: data.rate,
    selected: false,
  };
  this.state = SOLICIT_STATES.BIDDED;
  cb();
};

Solicitation.prototype.on_delete = function (agent, data, cb) {
  this.state = SOLICIT_STATES.DELETED;

  log.debug("%s %s solicitation %s", agent.toString(), data.action, this.toString());

  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[self.state]
  }, cb);
};

Solicitation.prototype.on_hire = function (agent, data, cb) {
  var self = this,
    auto,
    contractor = this.contractors[data.username],
    user,
    perms_list = ["view_room", "request_perms", "edit_room"];

  if (agent !== this.creator) {
    return cb("Only the creator of this solicitation can hire someone.");
  }
  if (!contractor) {
    return cb(util.format("Can't hire %s because they did not bid on this solicitation.", data.username));
  }

  contractor.selected = true;
  user = contractor.agent;
  this.state = SOLICIT_STATES.HIRED;

  auto = {
    solicitation_hire: function (cb) {
      api_client.solicitation_set(self.id, {
        contractor: user.username,
        start: new Date().toISOString(),
        rate: contractor.rate,
        state: SOLICIT_STATES_REVERSE[self.state],
      }, cb);
    },
    perms_set: function (cb) {
      api_client.perms_set(user.user_id, self.id, perms_list, cb);
    }
  };

  async.auto(auto, function (err, result) {
    if (err) {
      log.error("Error finishing solicitation %s: %s", self.id, err);
    }
    return cb(err, result);
  });
};


Solicitation.prototype.on_cancel = function (agent, data, cb) {
  this.state = SOLICIT_STATES.CANCELED;

  log.debug("%s %s solicitation %s", agent.toString(), data.action, this.toString());

  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[this.state]
  }, cb);
};

Solicitation.prototype.on_complete = function (agent, data, cb) {
  this.state = SOLICIT_STATES.COMPLETED;

  log.debug("%s %s solicitation %s", agent.toString(), data.action, this.toString());

  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[this.state]
  }, cb);
};

module.exports = {
  STATES: SOLICIT_STATES,
  Solicitation: Solicitation,
};
