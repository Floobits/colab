"use strict";

var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var api_client = require("./api_client");
var settings = require("./settings");


var SOLICIT_STATES = {
  CREATED: 1,
  BIDDED: 2,
  CANCELED: 3,
  HIRED: 4,
  ABSOLVED: 5,
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
  this.tags = data.tags;

  this.update_timeout = null;
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
    description: this.description,
    tags: this.tags,
  };
  return data;
};

Solicitation.prototype.toString = function () {
  var s = util.format("%s creator %s for %s state %s", this.id, this.creator.toString(), this.path, SOLICIT_STATES_REVERSE[this.state]);
  if (this.start) {
    s += util.format(" start %s", this.start);
  }
  if (this.end) {
    s += util.format(" end %s", this.end);
  }
  return s;
};

Solicitation.prototype.update_end = function () {
  var end = new Date().toISOString();

  if (this.state !== SOLICIT_STATES.HIRED) {
    log.warn("update_end: state is no longer hired! %s", this.toString());
    return;
  }

  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[this.state],
    end: end,
  }, function (err) {
    if (err) {
      log.error("Could not update %s with end %s: %s", this.id, end, err);
    }
    this.update_timeout = setTimeout(this.update_end.bind(this), settings.solicitation_update_timeout);
  }.bind(this));
};

Solicitation.prototype.start_update_timeout = function () {
  if (this.update_timeout) {
    log.error("%s start_update_timeout called but update_timeout already exists! This should never happen!");
    return;
  }
  this.update_end();
};

Solicitation.prototype.stop_update_timeout = function () {
  if (!this.update_timeout) {
    log.error("stop_update_timeout: No update_timeout for %s", this.toString());
  }
  clearTimeout(this.update_timeout);
  this.update_timeout = null;
};

Solicitation.prototype.on_create = function (agent, data, cb) {
  var self = this;
  log.debug("%s create solicitation %s", agent.toString(), this.toString());

  api_client.solicitation_create({
    path: self.path,
    preferred_contractor: self.preferred_contractor,
    description: self.description,
    user: self.creator.username,
    state: SOLICIT_STATES_REVERSE[self.state]
  }, function (err, result) {
    if (result) {
      self.id = result.id;
    }
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

Solicitation.prototype.on_cancel = function (agent, data, cb) {
  this.state = SOLICIT_STATES.CANCELED;

  log.debug("%s cancel solicitation %s", agent.toString(), this.toString());

  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[this.state]
  }, cb);
};

Solicitation.prototype.on_hire = function (agent, data, hire_cb) {
  var self = this,
    auto,
    contractor = this.contractors[data.username],
    user,
    perms_list = ["view_room", "request_perms", "edit_room"];

  if (agent !== this.creator) {
    return hire_cb("Only the creator of this solicitation can hire someone.");
  }
  if (!contractor) {
    return hire_cb(util.format("Can't hire %s because they did not bid on this solicitation.", data.username));
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
      // TODO: either figure out workspace id or use a different api
      api_client.perms_set(user.user_id, self.path, perms_list, cb);
    }
  };

  async.auto(auto, function (err, result) {
    if (err) {
      log.error("Error finishing solicitation %s: %s", self.id, err);
    }
    this.start_update_timeout();
    return hire_cb(err, result);
  }.bind(this));
};


Solicitation.prototype.on_absolve = function (agent, data, cb) {
  this.state = SOLICIT_STATES.ABSOLVED;

  log.debug("%s absolve solicitation %s", agent.toString(), this.toString());
  this.stop_update_timeout();
  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[this.state]
  }, cb);
};

Solicitation.prototype.on_complete = function (agent, data, cb) {
  this.state = SOLICIT_STATES.COMPLETED;

  log.debug("%s complete solicitation %s", agent.toString(), this.toString());
  this.stop_update_timeout();
  // TODO: remove perms?
  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[this.state],
    end: new Date().toISOString(),
  }, function (err, res) {
    if (err) {
      return cb(err, res);
    }
    api_client.solicitation_charge(this.id, {}, cb);
  }.bind(this));
};

Solicitation.prototype.on_feedback = function (agent, data, cb) {
  var contractor;
  log.debug("%s feedback solicitation %s", agent.toString(), this.toString());

  if (!_.contains([SOLICIT_STATES.ABSOLVED, SOLICIT_STATES.COMPLETED], this.state)) {
    // TODO: better error message
    return cb("You can't give feedback yet!");
  }

  contractor = _.find(this.contractors, function (c) {
    return c.selected;
  });

  if (!contractor || !contractor.agent) {
    return cb("Invalid contractor!");
  }

  api_client.feedback_create({
    solicitation: this.id,
    rating: data.rating,
    text: data.text,
    for_user: contractor.agent.username,
    reviewer: this.creator.username,
  }, cb);
};

module.exports = {
  STATES: SOLICIT_STATES,
  Solicitation: Solicitation,
};
