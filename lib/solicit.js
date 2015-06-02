"use strict";

const util = require("util");

const async = require("async");
const log = require("floorine");
const _ = require("lodash");

const api_client = require("./api_client");
const settings = require("./settings");


const SOLICIT_STATES = {
  CREATED: 1,
  BIDDED: 2,
  CANCELED: 3,
  HIRED: 4,
  ABSOLVED: 5,
  COMPLETED: 6,
};

const SOLICIT_STATES_REVERSE = _.invert(SOLICIT_STATES);

const Solicitation = function (data) {
  this.state = SOLICIT_STATES.CREATED;
  this.contractors = {};
  this.path = null;
  this.username = null;
  this.id = null;
  this.preferred_contractor = null;
  this.description = null;
  this.tags = null;
  this.start = null;
  this.end = null;
  this.created_at = null;
  this.updated_at = null;
  this.update_timeout = null;

  this.from_json(data);
};

Solicitation.prototype.toString = function () {
  var s = util.format("%s creator %s for %s state %s", this.id, this.username, this.path, SOLICIT_STATES_REVERSE[this.state]);
  if (this.start) {
    s += util.format(" start %s", this.start);
  }
  if (this.end) {
    s += util.format(" end %s", this.end);
  }
  return s;
};

Solicitation.prototype.to_json = function () {
  var data = {
    state: SOLICIT_STATES_REVERSE[this.state],
    creator: this.username,
    contractors: _.map(this.contractors, function (c) { return c; }),
    id: this.id,
    path: this.path,
    preferred_contractor: this.preferred_contractor,
    description: this.description,
    tags: this.tags,
    start: this.start,
    end: this.end,
    created_at: this.created_at,
    updated_at: this.updated_at,
  };
  return data;
};

Solicitation.prototype.from_json = function (data) {
  const self = this;
  self.state = SOLICIT_STATES[data.state];

  _.each(["username", "id", "path", "preferred_contractor", "description", "tags"], function (k) {
    self[k] = data[k];
  });

  _.each(["created_at", "updated_at", "start", "end"], function (k) {
    const v = data[k];
    if (!v) {
      return;
    }
    self[k] = new Date(data[k]);
  });

  // TODO: why do we need this??
  if (data.user && self.username !== data.user) {
    // Stomp over creator if it's not the same as what's in the DB
    self.username = data.user;
  }

  if (data.contractor && _.isFinite(data.rate)) {
    this.contractors[data.contractor] = {
      rate: data.rate,
      selected: true,
      username: data.contractor,
    };
  }
  return self;
};

Solicitation.prototype.update_end = function () {
  const self = this;
  this.end = new Date().toISOString();

  if (this.state !== SOLICIT_STATES.HIRED) {
    log.warn("update_end: state is no longer hired! %s", this.toString());
    return;
  }

  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[this.state],
    end: self.end,
  }, function (err) {
    if (err) {
      log.error("Could not update %s with end %s: %s", this.id, self.end, err);
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
    user: self.username,
    tags: self.tags,
    state: SOLICIT_STATES_REVERSE[self.state]
  }, function (err, result) {
    if (result) {
      self.id = result.id;
      self.updated_at = Date.parse(result.updated_at);
      self.created_at = Date.parse(result.created_at);
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
    username: agent.username,
    rate: data.rate,
    selected: false,
  };
  this.state = SOLICIT_STATES.BIDDED;
  cb();
};

Solicitation.prototype.on_cancel = function (agent, data, cb) {
  this.state = SOLICIT_STATES.CANCELED;

  log.debug("%s cancel solicitation %s", agent.toString(), this.toString());

  const self = this;
  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[this.state]
  }, function (err, result) {
    if (result) {
      self.updated_at = Date.parse(result.updated_at);
    }
    return cb(err, result);
  });
};

Solicitation.prototype.on_hire = function (agent, data, hire_cb) {
  const self = this,
    contractor = this.contractors[data.username],
    perms_list = ["view_room", "request_perms", "edit_room"];

  if (agent.username !== this.username) {
    return hire_cb("Only the creator of this solicitation can hire someone.");
  }

  if (!contractor) {
    return hire_cb(util.format("Can't hire %s because they did not bid on this solicitation.", data.username));
  }

  contractor.selected = true;
  this.state = SOLICIT_STATES.HIRED;
  this.start = new Date();

  const auto = {
    solicitation_hire: function (cb) {
      api_client.solicitation_set(self.id, {
        contractor: contractor.username,
        start: self.start.toISOString(),
        rate: contractor.rate,
        state: SOLICIT_STATES_REVERSE[self.state],
      }, cb);
    },
    perms_set: function (cb) {
      // TODO: either figure out workspace id or use a different api
      api_client.perms_set(contractor.username, self.path, perms_list, cb);
    }
  };

  async.auto(auto, function (err, result) {
    if (err) {
      log.error("Error finishing solicitation %s: %s", self.id, err);
    } else if (result) {
      self.updated_at = Date.parse(result.updated_at);
    }
    this.start_update_timeout();
    return hire_cb(err, result);
  }.bind(this));
};


Solicitation.prototype.on_absolve = function (agent, data, cb) {
  this.state = SOLICIT_STATES.ABSOLVED;

  log.debug("%s absolve solicitation %s", agent.toString(), this.toString());
  this.stop_update_timeout();
  const self = this;
  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[this.state]
  }, function (err, result) {
    if (result) {
      self.updated_at = Date.parse(result.updated_at);
    }
    return cb(err, result);
  });
};

Solicitation.prototype.on_complete = function (agent, data, complete_cb) {
  this.state = SOLICIT_STATES.COMPLETED;

  log.debug("%s complete solicitation %s", agent.toString(), this.toString());
  this.stop_update_timeout();

  const self = this, auto = {
    solicitation_complete: function (cb) {
      api_client.solicitation_set(self.id, {
        state: SOLICIT_STATES_REVERSE[self.state],
        end: new Date().toISOString(),
      }, function (err, res) {
        if (err) {
          return cb(err, res);
        }
        api_client.solicitation_charge(self.id, {}, cb);
      });
    },
    perms_remove: function (cb) {
      // Give contractor read-only perms for now
      const perms_list = ["view_room", "request_perms"];
      api_client.perms_set(agent.username, self.path, perms_list, cb);
    },
  };
  async.auto(auto, function (err, result) {
    if (err) {
      log.error("Error completing solicitation %s: %s", self.id, err);
    } else {
      self.updated_at = Date.parse(result.updated_at);
    }
    return complete_cb(err, result);
  });
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
    reviewer: this.username,
  }, cb);
};

module.exports = {
  STATES: SOLICIT_STATES,
  Solicitation: Solicitation,
};
