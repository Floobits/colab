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

var Solicitation = function (agent, data) {
  this.state = SOLICIT_STATES.CREATED;
  this.creator = agent;
  this.contractors = [];

  this.id = data.id;
  this.path = data.path;
  this.preferred_contractor = data.preferred_contractor;
  this.description = data.description;
};

Solicitation.prototype.accept = function (agent, data) {
  this.contractors.push({
    agent: agent,
    rate: data.rate,
  });
};

module.exports = {
  STATES: SOLICIT_STATES,
  Solicitation: Solicitation,
};
