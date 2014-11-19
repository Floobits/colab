/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var log = require("floorine");
var _ = require("lodash");


var SOLICIT_STATES = {
  CREATED: 1,
  ACCEPTED: 2,
  DELETED: 3,
  FINISHED: 4,
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
    contractors: _.map(this.contractors, function (c) {
      return c.agent.to_json();
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

  this.contractors.push({
    agent: agent,
    rate: data.rate,
  });
  this.state = SOLICIT_STATES.ACCEPTED;
};

Solicitation.prototype.delete = function () {
  this.state = SOLICIT_STATES.DELETED;
};

Solicitation.prototype.finish = function () {
  this.state = SOLICIT_STATES.FINISHED;
};


module.exports = {
  STATES: SOLICIT_STATES,
  Solicitation: Solicitation,
};
