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
  ACCEPTED: 2,
  DELETED: 3,
  FINISHED: 4,
  CANCELED: 5,
  FINALIZED: 6,
};

var SOLICIT_STATES_REVERSE = _.invert(SOLICIT_STATES);

var Solicitation = function (agent, data) {
  this.state = SOLICIT_STATES.CREATED;
  this.creator = agent;
  this.contractors = [];

  this.id = data.id;
  this.path = data.path;
  this.preferred_contractor = data.preferred_contractor;
  this.description = data.description;
};

Solicitation.prototype.to_json = function () {
  return {
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
};

Solicitation.prototype.accept = function (agent, data) {
  if (!_.contains([SOLICIT_STATES.CREATED, SOLICIT_STATES.ACCEPTED], this.state)) {
    throw new Error(util.format("Cannot accept! Solicitation is already in state %s",
      SOLICIT_STATES_REVERSE[this.state]));
  }

  this.contractors[agent.username] = {
    agent: agent,
    rate: data.rate,
    selected: false,
  };
  this.state = SOLICIT_STATES.ACCEPTED;
};

Solicitation.prototype.delete = function () {
  this.state = SOLICIT_STATES.DELETED;
};

Solicitation.prototype.finish = function (agent, data, cb) {
  var auto,
    contractor = this.contractors[data.username],
    owner_room = this.path.split("/"),
    user,
    perms_list = perms.db_perms_mapping.edit_room;

  if (agent !== this.creator) {
    return cb("Only the creator of this solicitation can finish it.");
  }
  if (!contractor) {
    return cb(util.format("Can't hire %s because they did not accept this solicitation.", data.username));
  }

  contractor.selected = true;
  user = contractor.agent;

  auto = {
    workspace_get: function (cb) {
      api_client.workspace_get(owner_room[0], owner_room[1], cb);
    },
    perms_set: ["workspace_get", function (cb, res) {
      api_client.perms_set(user.user_id, res.workspace_get.id, perms_list, cb);
    }]
  };

  async.auto(auto, function (err, result) {
    if (err) {
      log.error("Error finishing solicitation %s: %s", this.id, err);
      return cb(err, result);
    }
    this.state = SOLICIT_STATES.FINISHED;
    return cb(null, result);
  }.bind(this));
};


Solicitation.prototype.cancel = function () {
  return;
};

module.exports = {
  STATES: SOLICIT_STATES,
  Solicitation: Solicitation,
};
