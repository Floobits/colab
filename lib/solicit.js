"use strict";

const util = require("util");

const async = require("async");
const log = require("floorine");
const _ = require("lodash");

const api_client = require("./api_client");
const settings = require("./settings");
const actions = require("./actions");

const ABSOLVE_CUTOFF = 360000; // 1000 * 60 * 6

const SOLICIT_STATES = {
  CREATED: 1,
  BIDDED: 2,
  CANCELED: 3,
  HIRED: 4,
  JOINED: 5,
  ABSOLVED: 6,
  COMPLETED: 7,
};

const SOLICIT_STATES_REVERSE = _.invert(SOLICIT_STATES);

const Solicitation = function (data) {
  this.state = SOLICIT_STATES.CREATED;
  this.contractors = {};
  this.path = null;
  this.client_account = null;
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
  this.duration = null;
  this.cut = null;
  this.total_bill = null;
  this.last_keep_alive = null;

  let state = SOLICIT_STATES[data.state];
  // TODO: do this better - see if the Pro is still connected, etc
  if (state === SOLICIT_STATES.BIDDED) {
    state = SOLICIT_STATES.CREATED;
  }
  const self = this;

  _.each(["username", "id", "path", "preferred_contractor", "description",
    "tags", "total_bill", "cut", "duration", "client_account"], function (k) {
    self[k] = data[k];
  });

  _.each(["created_at", "updated_at", "start", "end"], function (k) {
    const v = data[k];
    if (!v) {
      return;
    }
    self[k] = Date.parse(data[k]);
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
  self.enter_state("reloaded", state);
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
  return {
    client_account: this.client_account,
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
    duration: this.duration,
    cut: this.cut,
    total_bill: this.total_bill,
    created_at: this.created_at,
    updated_at: this.updated_at,
  };
};

Solicitation.prototype.get_selected_contractor = function () {
  const contractor = _.find(this.contractors, function (c) {
    return c.selected;
  });
  return contractor && contractor.username;
};

Solicitation.prototype.update_end = function () {
  const self = this;
  const end = new Date();
  this.end = Date.parse(end);
  if (this.state !== SOLICIT_STATES.JOINED) {
    log.error("update_end: state is no longer joined! %s", this.toString());
    return;
  }

  // To prevent multiple update_timeouts from being set when two people join at almost the same time
  self.update_timeout = true;

  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[this.state],
    end: end.toISOString(),
  }, function (err, result) {
    if (!self.update_timeout) {
      // Got cancelled during solicitation_set.
      return;
    }
    if (self.state !== SOLICIT_STATES.JOINED) {
      log.warn("update_end: state is no longer joined! %s", self.toString());
      return;
    }
    self.update_timeout = setTimeout(self.update_end.bind(self), settings.solicitation_update_timeout);
    if (err) {
      log.error("update_end: Could not update %s with end %s: %s", self.toString(), self.end, err);
      return;
    }
    self.duration = result.duration;
    self.total_bill = result.total_bill;
    const broadcast_data = {
      data: self.to_json(),
      name: "solicit",
    };
    actions.broadcast.send_to_path(self.path, self.path, broadcast_data, function (broadcast_err) {
      if (broadcast_err) {
        log.error(broadcast_err);
      }
    });
  });
};

Solicitation.prototype.start_update_timeout = function () {
  const self = this;

  if (this.update_timeout) {
    log.error("%s start_update_timeout called but update_timeout already exists! This should never happen!");
    return;
  }
  if (this.last_keep_alive) {
    // TODO: this is super weird
    clearTimeout(this.last_keep_alive);
  }
  this.last_keep_alive = setTimeout(self.complete.bind(self), settings.solicitation_keep_alive_timeout);
  this.update_end();
};

Solicitation.prototype.stop_update_timeout = function () {
  clearTimeout(this.update_timeout);
  clearTimeout(this.last_keep_alive);
  this.update_timeout = null;
  this.last_keep_alive = null;
};

Solicitation.prototype.complete = function (complete_cb) {
  const end = new Date();
  this.end = Date.parse(end);
  const self = this;

  complete_cb = complete_cb || function (err) {
    if (err) {
      log.error("Error completing solicitation:", err);
    }
  };

  const auto = {
    solicitation_complete: function (cb) {
      api_client.solicitation_set(self.id, {
        state: SOLICIT_STATES_REVERSE[SOLICIT_STATES.COMPLETED],
        end: end.toISOString(),
      }, cb);
    },
    perms_remove: function (cb) {
      // TODO: take out of auto or do first or something
      // Give contractor read-only perms for now
      const perms_list = ["view_room", "request_perms"];
      api_client.perms_set(self.get_selected_contractor(), self.path, perms_list, cb);
    },
    update_state: ["solicitation_complete", function (cb) {
      try {
        self.enter_state("", SOLICIT_STATES.COMPLETED);
      } catch (e) {
        cb(e);
      }
      cb();
    }],
    broadcast: ["update_state", function (cb) {
      const broadcast_data = {
        data: self.to_json(),
        name: "solicit",
      };
      actions.broadcast.send_to_path(self.path, self.path, broadcast_data, function (err) {
        if (err) {
          log.error(err);
        }
        cb();
      });
    }],
    charge: ["update_state", function (cb) {
      api_client.solicitation_charge(self.id, {}, function (err, result) {
        if (err) {
          log.error("Error charging for %s", self.id);
        }
        self.updated_at = Date.parse(result.updated_at);
        self.duration = result.duration;
        self.total_bill = result.total_bill;
        // TODO: tell pro and/or client ...
        cb(null, result);
      });
    }],
  };
  async.auto(auto, function (err, result) {
    if (err) {
      log.error("Error completing solicitation %s: %s", self.id, err);
    }
    log.log("completed %s!", self.id);
    return complete_cb(err, result);
  });
};

Solicitation.prototype.enter_state = function (agent_name, state) {
  log.debug("%s %s %s", agent_name, state, this.toString());

  if (state < this.state) {
    const to_state = SOLICIT_STATES_REVERSE[state] || state;
    const from_state = SOLICIT_STATES_REVERSE[this.state] || this.state;
    throw new Error(util.format("Can't go from state %s to %s.", from_state, to_state));
  }

  if (state === this.state) {
    log.log("Already in state %s", this.state);
  }

  this.state = state;

  const s = SOLICIT_STATES;
  switch (state) {
    case s.CREATED:
    case s.BIDDED:
    case s.CANCELED:
    case s.HIRED:
      break;
    case s.JOINED:
      this.start_update_timeout();
      break;
    case s.ABSOLVED:
    case s.COMPLETED:
      this.stop_update_timeout();
      break;
    default:
      break;
  }
};


Solicitation.prototype.on_create = function (agent, data, cb) {
  var self = this;

  try {
    self.enter_state(agent.username, SOLICIT_STATES.CREATED);
  } catch (e) {
    return cb(e);
  }
  // TODO: the API call can fail... thats really not good
  api_client.solicitation_create({
    path: self.path,
    client_account: self.client_account,
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
  try {
    this.enter_state(agent.username, SOLICIT_STATES.BIDDED);
  } catch (e) {
    return cb(e);
  }

  this.contractors[agent.username] = {
    username: agent.username,
    rate: data.rate,
    selected: false,
  };
  cb();
};

Solicitation.prototype.on_cancel = function (agent, data, cb) {
  const self = this;

  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[SOLICIT_STATES.CANCELED]
  }, function (err, result) {
    if (err || !result) {
      return cb(err, result);
    }
    try {
      self.enter_state(agent.username, SOLICIT_STATES.CANCELED);
    } catch (e) {
      return cb(e, result);
    }
    self.updated_at = Date.parse(result.updated_at);
    return cb(err, result);
  });
};

Solicitation.prototype.on_hire = function (agent, data, hire_cb) {
  const self = this;

  // if (agent.username !== this.username) {
  //   return hire_cb("Only the creator of this solicitation can hire someone.");
  // }

  const contractor = this.contractors[data.username];
  if (!contractor) {
    return hire_cb(util.format("Can't hire %s because they did not bid on this solicitation.", data.username));
  }

  contractor.selected = true;

  // TODO: decouple these - do something if only one fails
  const auto = {
    verify_charge: function (cb) {
      api_client.verify_charge(self.client_account, cb);
    },
    solicitation_hire: ["verify_charge", function (cb) {
      api_client.solicitation_set(self.id, {
        contractor: contractor.username,
        rate: contractor.rate,
        state: SOLICIT_STATES_REVERSE[SOLICIT_STATES.HIRED],
      }, cb);
    }],
    perms_set: ["verify_charge", function (cb) {
      const perms_list = ["view_room", "request_perms", "edit_room"];
      // TODO: either figure out workspace id or use a different api
      api_client.perms_set(contractor.username, self.path, perms_list, cb);
    }]
  };

  async.auto(auto, function (err, result) {
    if (err) {
      log.error("Error finishing solicitation %s: %s", self.id, err);
    } else if (result.solicitation_hire) {
      try {
        self.enter_state(agent.username, SOLICIT_STATES.HIRED);
      } catch (e) {
        return hire_cb(e, result);
      }
      self.updated_at = Date.parse(result.solicitation_hire.updated_at);
    }
    return hire_cb(err, result);
  });
};

Solicitation.prototype.on_join = function (agent, data, cb) {
  const self = this;
  const contractor = this.contractors[agent.username];

  // we get these events for anyone with the contractor flag set
  if (!contractor || !contractor.selected || self.state !== SOLICIT_STATES.HIRED) {
    log.warn("Don't care about this");
    return cb();
  }

  const start = new Date();
  const req = {
    start: start.toISOString(),
    state: SOLICIT_STATES_REVERSE[SOLICIT_STATES.JOINED]
  };

  api_client.solicitation_set(self.id, req, function (err, result) {
    if (err) {
      log.error("Error finishing solicitation %s: %s", self.id, err);
      // TODO: hacky, but better than not setting the state back
    } else if (result) {
      try {
        self.enter_state(agent.username, SOLICIT_STATES.JOINED);
      } catch (e) {
        return cb(e, result);
      }
      self.start = Date.parse(start);
      self.updated_at = Date.parse(result.updated_at);
      self.duration = result.duration;
      self.total_bill = result.total_bill;
      self.cut = result.cut;
    }
    return cb(err, result);
  });
};

Solicitation.prototype.on_keep_alive = function (agent, data, cb) {
  const self = this;
  clearTimeout(self.last_keep_alive);
  self.last_keep_alive = setTimeout(function () {
    log.log("Completing solicitation %s because no keep alive from %s", self.toString(), agent.username);
    self.complete();
    // TODO: tell the client
  }, settings.solicitation_keep_alive_timeout);
  cb();
};

Solicitation.prototype.on_absolve = function (agent, data, cb) {
  const self = this;
  const end = new Date();
  this.end = Date.parse(end);

  if (this.end && this.start && this.end - this.start > ABSOLVE_CUTOFF) {
    return cb("You may only cancel your Pro session in the first 5 minutes!");
  }

  api_client.solicitation_set(this.id, {
    state: SOLICIT_STATES_REVERSE[SOLICIT_STATES.ABSOLVED]
  }, function (err, result) {
    if (result) {
      try {
        self.enter_state(agent.username, SOLICIT_STATES.ABSOLVED);
      } catch (e) {
        return cb(e, result);
      }
      self.updated_at = Date.parse(result.updated_at);
      self.duration = result.duration;
      self.total_bill = result.total_bill;
    }
    return cb(err, result);
  });
};

Solicitation.prototype.on_complete = function (agent, data, cb) {
  log.log("%s completed %s", agent.username, this.id);
  this.complete(cb);
};

Solicitation.prototype.on_feedback = function (agent, data, cb) {
  log.debug("%s feedback solicitation %s", agent.toString(), this.toString());

  if (!_.contains([SOLICIT_STATES.ABSOLVED, SOLICIT_STATES.COMPLETED], this.state)) {
    // TODO: better error message
    return cb("You can't give feedback yet!");
  }

  const contractor = this.get_selected_contractor();

  if (!contractor) {
    return cb("Invalid contractor!");
  }

  api_client.feedback_create({
    solicitation: this.id,
    rating: data.rating,
    text: data.text,
    for_user: contractor,
    reviewer: this.username,
  }, cb);
};

module.exports = {
  STATES: SOLICIT_STATES,
  Solicitation,
};
