"use strict";

const util = require("util");

const _ = require("lodash");
const async = require("async");
const log = require("floorine");

const actions = require("../actions");
const settings = require("../settings");


const Master = function (api_server) {
  const self = this;
  if (!_.isFinite(settings.repcount) || settings.repcount < 1) {
    throw new Error(util.format("settings.repcount is invalid: %s!", settings.repcount));
  }

  if (settings.log_level !== "debug") {
    if (settings.repcount < 3) {
      throw new Error("Production server, but repcount is less than 3. SHUT IT DOWN!");
    }
  }

  settings.actions_per_pass = settings.actions_per_pass || 100;
  settings.actions_outstanding = settings.actions_outstanding || 25;
  settings.rebalance_interval = settings.rebalance_interval || 11000;

  self.server_mapping = {
    "token": {},
    "workspace": {},
    "username": {}
  };
  self.workspace_mapping_age = {};

  // {
  //   id: 10,
  //   slaves: {
  //     1: {
  //       version: 100,
  //       active: false,
  //     },
  //     2: {
  //       version: 100,
  //       active: true,
  //     },
  //     3: {
  //       version: 99,
  //       active: false,
  //     },
  //   },
  // }
  self.workspaces = {};
  self.moved_workspaces = [];

  self.replicate_interval_id = null;
  // Info about the most recent replication. (start/end time, success/failures, etc)
  self.last_rep = {};
  self.action_history = [];

  self.api_server = api_server;

  self.backup = false;

  self.slaves = {};
  actions.slave.onADD((id, slave_handler) => {
    log.log("Added slave %s", id);
    self.slaves[id] = slave_handler;
    if (slave_handler.backup) {
      self.backup = true;
      log.log("%s is a backup server. Backups enabled.", slave_handler.toString());
    }
    self.check_ready();
  });
  actions.slave.onREMOVE((id) => {
    log.log("Removed slave %s", id);
    // TODO: check for backups and disable them if backup server left
    self.check_ready();
  });
  actions.slave.onUPDATE_COUNTS(function (id, workspaces) {
    const slave = self.slaves[id];
    log.log("Updating counts for %s", slave.toString());
    _.each(self.workspaces, function (w) {
      delete w.slaves[id];
    });
    _.each(workspaces, function (w) {
      self.update_count(slave, w);
    });
  });
  actions.slave.onCREATE_WORKSPACE(function (id, workspace) {
    const data = {
      id: workspace.id,
      slaves: {}
    };

    data.slaves[id] = {
      version: workspace.version || 0,
      active: workspace.active || false
    };
    self.workspaces[workspace.id] = data;
    self.update_count(self.slaves[id], workspace);
  });
  actions.slave.onDELETE_WORKSPACE(function (id, workspace) {
    self.update_count(self.slaves[id], workspace);
  });
  actions.slave.onUPDATE_WORKSPACE(function (id, workspace) {
    self.update_count(self.slaves[id], workspace);
  });

  actions.conn.onEND(self.on_conn_end, this);
  actions.broadcast.onSEND_TO_SLAVES(this.on_send_to_slaves, this);
};

Master.prototype.check_ready = function () {
  // TODO: check connected slaves?
  if (_.size(this.slaves) < settings.repcount) {
    log.log("%s slaves connected, < repcount %s. Master API is DOWN.", _.size(this.slaves), settings.repcount);
    if (this.api_server.controller) {
      this.api_server.set_controller(null);
    }
  } else {
    log.log("%s slaves connected, >= repcount %s. Master API is UP.", _.size(this.slaves), settings.repcount);
    if (!this.api_server.controller) {
      this.api_server.set_controller(this);
    }
  }
};

Master.prototype.on_send_to_slaves = function (source, data, send_cb) {
  this.async_each_slave(function (slave, cb) {
    slave.broadcast(data, cb);
  }, send_cb);
};

Master.prototype.update_count = function (slave, workspace) {
  let id = slave.id;

  if (workspace.active) {
    // active workspace
    let old_server = this.server_mapping.workspace[workspace.id];
    if (old_server && old_server.id !== slave.id) {
      // This should never happen
      log.error("OH NO! Workspace %s moved from %s to %s", workspace.id, old_server.id, slave.id);
      this.moved_workspaces.push({
        workspace: workspace,
        from: old_server.to_json(),
        to: slave.to_json()
      });
      this.moved_workspaces = this.moved_workspaces.slice(-100);
    }
    this.set_mapping(workspace.id, slave);
  }

  let w = this.workspaces[workspace.id];
  if (!w) {
    w = {
      id: workspace.id,
      slaves: {}
    };
    this.workspaces[workspace.id] = w;
  }
  w.slaves[id] = {
    version: workspace.version,
    active: workspace.active
  };
  if (workspace.users) {
    w.slaves[id].users = workspace.users;
  }
};

Master.prototype.on_conn_end = function (proto) {
  const self = this;
  if (!proto.handler) {
    return;
  }

  const slave_id = proto.handler.id;
  const slave = self.slaves[slave_id];
  if (!slave) {
    // It's a normal colab client conn. None of our business.
    log.debug("No slave with id %s", slave_id);
    return;
  }

  // Prevent race condition where old conn dies after new one is set up.
  if (self.slaves[slave_id] !== proto.handler) {
    log.log("%s isn't current slave %s", proto.toString(), slave_id);
    return;
  }

  slave.disconnected = Date.now();

  // delete self.slaves[slave_id];
  // _.each(self.workspaces, function (w) {
  //   delete w.slaves[slave_id];
  // });
  log.warn("Slave %s disconnected. Repcounts updated.", slave.toString());
  // Stop trying to back up if no backup servers are available
  self.backup = _.some(self.slaves, function (s) {
    return s.backup;
  });
  log.log("Backups %s", (self.backup ? "enabled" : "disabled"));
};

Master.prototype.start = function () {
  const self = this;

  self.replicate();

  if (_.isFinite(settings.rebalance_threshold) && settings.rebalance_threshold < 1) {
    self.rebalance();
  } else {
    log.warn("Rebalance threshold is %s. Rebalancing disabled.", settings.rebalance_threshold);
  }
};

Master.prototype.set_mapping = function (workspace_id, slave) {
  const self = this;

  self.server_mapping.workspace[workspace_id] = slave;
  self.workspace_mapping_age[workspace_id] = 0;
};

Master.prototype.find_server = function (namespace, key) {
  const self = this;
  let slave = self.server_mapping[namespace][key];
  if (slave) {
    log.debug("%s %s is on %s", namespace, key, slave.toString());
    return slave.conn_info();
  }

  const servers = _.chain(self.slaves)
    .filter(function (server) {
      if (server.exclude) {
        return false;
      }
      if (server.disconnected) {
        return false;
      }
      if (server.backup) {
        return false;
      }
      return true;
    })
    .shuffle()
    .value();

  slave = _.find(servers, function (server) {
    let mem_used = server.load.heap.used_heap_size / Math.max(server.load.total_mem, server.load.heap.heap_size_limit);
    return server.load.loadavg[0] < settings.busy.loadavg && mem_used > settings.busy.mem_used;
  });

  if (slave) {
    log.debug("Picked %s for %s %s", slave.toString(), namespace, key);
  } else {
    // Nothing good. just pick one
    slave = servers[0];
    log.warn("All servers are busy. Randomly picked %s for %s %s", slave.toString(), namespace, key);
  }

  // This looks dangerous, but find_server is only called with namespace of token or username
  self.server_mapping[namespace][key] = slave;

  return slave.conn_info();
};

Master.prototype.create_workspace = function (workspace_id, cb) {
  const self = this;

  const slaves = _.chain(self.slaves)
    .filter(function (server) { return !server.exclude; })
    .shuffle()
    .value();

  if (slaves.length === 0) {
    return cb("No storage slaves available.");
  }

  let slave = _.find(slaves, function (server) {
    let mem_used = server.load.heap.used_heap_size / Math.max(server.load.total_mem, server.load.heap.heap_size_limit);
    return server.load.loadavg[0] < settings.busy.loadavg && mem_used > settings.busy.mem_used;
  });

  // Nothing good. just pick one
  if (slave) {
    log.debug("Picked %s for workspace %s", slave.toString(), workspace_id);
  } else {
    slave = slaves[0];
    log.warn("All servers are busy. Randomly picked %s for workspace %s", slave.toString(), workspace_id);
  }

  slave.workspace(workspace_id, "create", {
    version: 0,
  }, function (err, result) {
    return cb(err, result, slave);
  });
};

Master.prototype.get_backup_candidates = function (workspace) {
  const self = this;
  const candidates = {};
  candidates.source = self.get_source(workspace);
  candidates.dest = _.filter(self.slaves, function (colab) {
    return colab.backup;
  });

  if (candidates.dest.length === 0) {
    throw new Error(util.format("Couldn't find a backup server for %s", workspace.id));
  }

  candidates.dest = candidates.dest[0];
  return candidates;
};

Master.prototype.get_source = function (workspace) {
  const self = this;

  let source;
  let source_id;
  let source_version;
  _.shuffle(_.keys(workspace.slaves)).every(function (colab_id) {
    const colab = self.slaves[colab_id];
    const colab_version = workspace.slaves[colab_id].version;
    const active = workspace.slaves[colab_id].active;
    log.debug("Potential source for %s: %s version %s active %s", workspace.id, colab.toString(), colab_version, active);

    if (colab.disconnected) {
      log.debug("Skipping source %s for %s: Slave is not connected (%s)", colab.toString(), workspace.id, colab.disconnected);
      return true;
    }
    if (colab.exclude && !colab.backup) {
      return true;
    }
    if (!source) {
      source = colab;
      source_id = colab_id;
      source_version = colab_version;
    }
    if (active) {
      log.debug("Selected active source %s for %s.", colab.toString(), workspace.id);
      source = colab;
      source_id = colab_id;
      source_version = colab_version;
      return false;
    }
    if (colab_version > source_version) {
      log.debug("Source for %s: %s version %s > %s %s.", workspace.id, colab.toString(), colab_version, source.toString(), source_version);
      source = colab;
      source_id = colab_id;
      source_version = colab_version;
    }
    return true;
  });

  source = self.slaves[source_id];
  if (!source) {
    throw new Error(util.format("Couldn't find a source for %s", workspace.id));
  }
  return source;
};

Master.prototype.get_copy_candidates = function (workspace) {
  const self = this;

  let source;
  let source_id;
  let source_version;
  _.shuffle(_.keys(workspace.slaves)).every(function (colab_id) {
    const colab = self.slaves[colab_id];
    const colab_version = workspace.slaves[colab_id].version;
    const active = workspace.slaves[colab_id].active;
    log.debug("Potential source for %s: %s version %s active %s", workspace.id, colab.toString(), colab_version, active);

    if (colab.disconnected) {
      log.debug("Skipping source %s for %s: Slave is not connected (%s)", colab.toString(), workspace.id, colab.disconnected);
      return true;
    }
    if (!source) {
      source = colab;
      source_id = colab_id;
      source_version = colab_version;
    }
    if (active) {
      log.debug("Selected active source %s for %s.", colab.toString(), workspace.id);
      source = colab;
      source_id = colab_id;
      source_version = colab_version;
      return false;
    }
    if (colab_version > source_version) {
      log.debug("Source for %s: %s version %s > %s %s.", workspace.id, colab.toString(), colab_version, source.toString(), source_version);
      source = colab;
      source_id = colab_id;
      source_version = colab_version;
    }
    return true;
  });

  source = self.slaves[source_id];
  if (!source) {
    throw new Error(util.format("Couldn't find a source for %s", workspace.id));
  }

  let dest;
  let dest_id;
  _.each(_.shuffle(_.keys(workspace.slaves)), function (colab_id) {
    const colab = workspace.slaves[colab_id];
    const scolab = self.slaves[colab_id];
    if (scolab && (scolab.exclude || scolab.disconnected)) {
      return;
    }
    if (colab_id === source_id) {
      return;
    }
    if (!dest && colab.version < source_version) {
      dest = colab;
      dest_id = colab_id;
    }
    if (!dest) {
      return;
    }
    if (colab.version < dest.version) {
      dest = colab;
      dest_id = colab_id;
      return;
    }
    if (scolab.load.disk.usage < self.slaves[dest_id].load.disk.usage) {
      log.debug("Picked %s because it has lower disk than %s", scolab.toString(), self.slaves[dest_id].toString());
      dest = colab;
      dest_id = colab_id;
    }
  });

  /* Warning: If only two copies exist and one is old, we could only have a repcount of 2
     for a long time (assuming the workspace is being edited).
   */
  if (!dest) {
    _.each(_.shuffle(_.values(self.slaves)), function (colab) {
      if (colab.exclude || colab.disconnected || _.includes(_.keys(workspace.slaves), colab.id)) {
        return;
      }
      if (!dest) {
        dest = colab;
        dest_id = colab.id;
      }
    });
  }

  dest = self.slaves[dest_id];
  if (!dest) {
    throw new Error(util.format("Couldn't find a destination for %s", workspace.id));
  }

  return {
    source: source,
    dest: dest
  };
};

Master.prototype.copy_workspace = function (workspace, source, dest, cb) {
  workspace.action.running = true;
  log.log("Copying %s from %s to %s.", workspace.id, source.toString(), dest.toString());

  cb = cb || function (err) {
    if (err) {
      log.error(err);
    }
  };

  // TODO: make this decision when picking candidates
  dest.workspace(workspace.id, "fetch", source.conn_info(), function (err, result) {
    if (err) {
      log.error(err);
      return cb(500, err);
    }

    log.log("Copied %s from %s to %s.", workspace.id, source.toString(), dest.toString());

    if (!dest.id) {
      return cb(util.format("Destination %s has no id!", dest.toString()));
    }
    workspace.slaves[dest.id] = {
      version: result.version,
      active: result.active
    };

    return cb(null, result);
  });
};

Master.prototype.get_del_candidate = function (workspace) {
  const self = this;

  let colab;
  let colab_id;
  _.each(_.shuffle(_.keys(workspace.slaves)), function (candidate_id) {
    const candidate = workspace.slaves[candidate_id];
    log.debug("Deletion candidate for %s: %s version %s active %s",
      workspace.id,
      candidate_id,
      candidate.version,
      candidate.active);

    if (candidate.active) {
      log.debug("Not deleting workspace %s from %s because it's active.", workspace.id, candidate_id);
      return;
    }
    if (self.slaves[candidate_id].exclude) {
      return;
    }
    if (!colab) {
      colab = candidate;
      colab_id = candidate_id;
      return;
    }
    if (!_.isFinite(candidate.version)) {
      // Prefer deleting workspace versions that are null/undefined
      colab = candidate;
      colab_id = candidate_id;
      return;
    }
    if (candidate.version < colab.version) {
      colab = candidate;
      colab_id = candidate_id;
      return;
    }
    // TODO: check disk usage, etc
  });

  colab = self.slaves[colab_id];
  if (!colab) {
    throw new Error(util.format("No candidate to delete %s from.", workspace.id));
  }
  return colab;
};

Master.prototype.delete_workspace = function (workspace, colab, cb) {
  const self = this;

  workspace.action.running = true;

  const colab_id = colab.id;
  const colab_version = workspace.slaves[colab_id].version;
  // Reduce repcount immediately. If delete fails, slave will re-send workspace info and we'll pick it up again.
  delete workspace.slaves[colab_id];

  log.log("Deleting %s version %s from %s.", workspace.id, colab_version, colab.toString());

  cb = cb || function (err) {
    if (err) {
      log.error(err);
    }
  };

  colab.workspace(workspace.id, "delete", {}, function (err, result) {
    log.log("Deleted %s version %s from %s.", workspace.id, colab_version, colab.toString());
    delete workspace.slaves[colab_id];
    if (err) {
      log.error(err);
      return cb(500, err);
    }

    if (_.size(workspace.slaves) === 0) {
      // No more copies. Completely delete workspace.
      delete self.workspaces[workspace.id];
      delete self.server_mapping.workspace[workspace.id];
      delete self.workspace_mapping_age[workspace.id];
    }

    return cb(null, result);
  });
};

Master.prototype.move_workspace = function (workspace, source, dest, move_cb) {
  const self = this;

  log.debug("Moving workspace %s from %s to %s", workspace.id, source.toString(), dest.toString());

  const move = [
    function (cb) {
      self.copy_workspace(workspace, source, dest, cb);
    },
    function (cb) {
      self.delete_workspace(workspace, source, cb);
    }
  ];
  async.series(move, move_cb);
};

Master.prototype.drain = function (server) {
  const self = this;

  server.exclude = true;

  // TODO: disconnect users on drained server
  const filtered_mapping = {};
  _.each(self.server_mapping, function (mapping, key) {
    filtered_mapping[key] = _.filter(mapping, function (v) {
      return v.ip !== server.ip;
    });
  });
  self.server_mapping = filtered_mapping;
};

Master.prototype.rebalance = function () {
  const self = this;

  const slaves = _.filter(self.slaves, function (slave) {
    return !slave.exclude;
  });

  let tot_usage = 0;
  _.each(slaves, function (slave) {
    log.debug("%s disk usage is %s", slave.toString(), slave.load.disk.usage);
    if (!_.isFinite(slave.load.disk.usage)) {
      return;
    }
    tot_usage += slave.load.disk.usage;
  });
  const avg_usage = tot_usage / _.size(slaves);
  log.debug("Average usage: %s", avg_usage);

  let low = [];
  let high = [];
  _.each(slaves, function (slave, slave_id) {
    const diff = slave.load.disk.usage - avg_usage;
    if (diff > settings.rebalance_threshold) {
      log.debug("%s high diff %s", slave.toString(), diff);
      high.push(slave_id);
    } else if (diff < (-1 * settings.rebalance_threshold)) {
      low.push(slave_id);
      log.debug("%s low diff %s", slave.toString(), diff);
    }
  });

  log.log("Rebalancing: %s low, %s high.", _.size(low), _.size(high));
  async.forEach(high, function (colab, rebalance_cb) {
    colab = slaves[colab];
    log.debug("Rebalancing %s", colab.toString());
    const colab_workspaces = _.filter(self.workspaces, function (w) {
      return !!w.slaves[colab.id];
    });
    async.forEach(_.sample(colab_workspaces, 50), function (w, cb) {
      if (w.action) {
        log.log("Can't rebalance %s on %s: Action %s is %s.", w.id, colab.toString(), w.action.name, (w.action.running ? "running" : "not running"));
        return cb();
      }
      if (w.slaves[colab.id].active) {
        log.log("Can't rebalance %s on %s because it's active.", w.id, colab.toString());
        return cb();
      }
      if (_.size(w.slaves) < settings.repcount) {
        log.log("Can't rebalance %s on %s because repcount is low.", w.id, colab.toString());
        return cb();
      }
      let candidates;
      if (_.size(low) > 0) {
        candidates = _.map(low, function (c) {
          return slaves[c];
        });
      } else {
        candidates = _.values(slaves);
      }
      candidates = _.filter(candidates, function (c) {
        if (!c.id || c.id === colab.id) {
          return false;
        }
        // Don't try to copy to a colab that already has this workspace
        if (w.slaves[c.id]) {
          return false;
        }
        return true;
      });
      const dest = _.sample(candidates);
      if (!dest) {
        log.warn("No candidate to move %s %s to. Skipping.", colab.toString(), w.id);
        return cb();
      }
      w.action = {
        name: "move",
        from: colab.id,
        to: dest.id,
        workspace_id: w.id,
        running: false
      };
      self.move_workspace(w, colab, dest, function (err, result) {
        delete w.action;
        return cb(err, result);
      });
    }, function (err, result) {
      if (err) {
        log.error("Error moving workspaces from %s: %s", colab.toString(), err);
      }
      log.debug("Rebalanced %s", colab.toString());
      return rebalance_cb(err, result);
    });
  }, function (err) {
    if (err) {
      log.error("Error moving workspaces: %s", err);
    }
    self.rebalance_interval_id = setTimeout(self.rebalance.bind(self), settings.rebalance_interval);
  });
};

Master.prototype.make_action = function (id, name, get_candidate_f, workspace_action_f) {
  let action = {
    f: function (workspace, cb) {
      let candidate;
      try {
        candidate = get_candidate_f(workspace);
      } catch (e) {
        log.error("Error getting %s candidate for %s: %s", name, id, e.toString());
      }
      if (!candidate) {
        return cb(util.format("No candidate to %s %s!", name, id));
      }
      if (candidate.source && candidate.dest) {
        workspace.action.to = candidate.dest.id;
        workspace.action.from = candidate.source.id;
        workspace_action_f(workspace, candidate.source, candidate.dest, cb);
      } else {
        workspace.action.to = candidate.id;
        workspace_action_f(workspace, candidate, cb);
      }
    },
    name: name,
    workspace_id: id,
    running: false,
  };

  return action;
};

Master.prototype.get_action = function (id, w, last_rep, stats) {
  const self = this;

  let active = false;
  let backup_repcount = 0;
  let exclude_repcount = 0;
  let repcount = 0;
  let version;

  _.each(w.slaves, function (colab, slave_id) {
    const slave = self.slaves[slave_id];

    if (!_.isFinite(colab.version)) {
      log.warn("Workspace %s has bad version (%s) on colab %s", id, colab.version, slave.toString());
      log.warn("Workspace object in question: %s", JSON.stringify(w));
      return;
    }
    if (!_.isFinite(version)) {
      version = colab.version;
    }
    if (!slave) {
      log.warn("No source colab with id %s", slave_id);
      return;
    }
    active = active || colab.active;
    if (version !== colab.version) {
      log.debug("Workspace %s has different versions: %s %s", id, version, colab.version);
      if (version < colab.version) {
        version = colab.version;
      }
      return;
    }
    if (slave.disconnected && last_rep.started - slave.disconnected > settings.slave_error_threshold) {
      log.debug("Slave %s disconnected too long ago: %sms ago.", slave_id, (last_rep.started - slave.disconnected));
      if (self.server_mapping.workspace[id] && slave_id === self.server_mapping.workspace[id].id) {
        delete self.server_mapping.workspace[id];
        delete self.workspace_mapping_age[id];
      }
      colab.active = false;
      return;
    }
    if (slave.backup) {
      backup_repcount++;
      return;
    }
    if (slave.exclude) {
      exclude_repcount++;
      return;
    }
    repcount++;
  });

  if (active) {
    self.workspace_mapping_age[id] = 0;
  } else if (_.has(self.workspace_mapping_age, id)) {
    self.workspace_mapping_age[id]++;
    log.log("Mapping for workspace %s is age %s.", id, self.workspace_mapping_age[id]);
    if (self.workspace_mapping_age[id] > 2) {
      log.log("Mapping for workspace %s too old. Deleting.", id);
      delete self.server_mapping.workspace[id];
      delete self.workspace_mapping_age[id];
    }
  }

  if (w.action && w.action.running) {
    log.log("Action is running for %s", id);
    stats.running++;
    return null;
  }

  // high_repcount includes replicas that are old versions
  const high_repcount = _.size(w.slaves) - backup_repcount - exclude_repcount;

  let priority;
  if (self.backup && backup_repcount === 0) {
    log.debug("Workspace %s has %s backups (not enough).", id, backup_repcount);
    w.action = self.make_action(id, "backup", self.get_backup_candidates.bind(self), self.copy_workspace.bind(self));
    priority = 1;
  } else if (repcount === 0 && exclude_repcount === 0) {
    stats.low++;
    // Nothing we can do :(
    log.error("Repcount for %s is ZERO!", id);
  } else if (repcount < settings.repcount) {
    stats.low++;
    log.debug("Workspace %s has %s replicas (not enough).", id, repcount);
    w.action = self.make_action(id, "copy", self.get_copy_candidates.bind(self), self.copy_workspace.bind(self));
    priority = 1 + settings.repcount - repcount + !!_.find(w.slaves, { active: true });
  } else if (high_repcount > settings.repcount) {
    stats.high++;
    if (high_repcount === settings.repcount + 1) {
      if (high_repcount === repcount) {
        // We have one extra copy, and it's up to date.
        return null;
      }
      log.debug("Workspace %s has %s replicas (one too many). %s backups %s excluded.", id, high_repcount, backup_repcount, exclude_repcount);
      // We have one extra copy, but it's old. Update it.
      w.action = self.make_action(id, "copy", self.get_copy_candidates.bind(self), self.copy_workspace.bind(self));
      priority = settings.repcount - high_repcount + !!_.find(w.slaves, { active: true });
      return priority;
    }
    log.debug("Workspace %s has %s replicas (too many). %s backups %s excluded.", id, high_repcount, backup_repcount, exclude_repcount);
    w.action = self.make_action(id, "delete", self.get_del_candidate.bind(self), self.delete_workspace.bind(self));
    priority = settings.repcount - high_repcount - !!_.find(w.slaves, { active: true });
  } else {
    stats.correct++;
    if (w.action && _.includes(["copy", "delete"], w.action.name) && !w.action.running) {
      log.log("Cancelling action %s on %s", w.action.name, w.id);
      delete w.action;
    }
  }
  if (!w.action) {
    return null;
  }
  return priority;
};

Master.prototype.replicate = function () {
  const self = this;
  if (self.replicating) {
    log.warn("Replication already running. Started %sms ago", Date.now() - self.last_rep.started);
    return;
  }
  log.log("Replicating");

  clearTimeout(self.replicate_interval_id);
  self.replicate_interval_id = null;
  self.replicating = true;

  const last_rep = {
    started: Date.now(),
  };
  let action_workspaces = {};
  let stats = {
    correct: 0,
    high: 0,
    low: 0,
    running: 0,
  };
  _.each(self.workspaces, function (w, id) {
    if (!_.isFinite(parseInt(id, 10))) {
      log.error("WTF! Workspace id is %s", id);
      log.error("Workspace object in question: %s", JSON.stringify(w));
      return;
    }
    const priority = self.get_action(id, w, last_rep, stats);
    if (!_.isFinite(priority)) {
      return;
    }
    action_workspaces[priority] = action_workspaces[priority] || [];
    action_workspaces[priority].push(w);
  });

  log.log("Replication counts: %s running. %s low. %s high. %s correct.", stats.running, stats.low, stats.high, stats.correct);
  self.workspace_stats = stats;

  const priorities = _.keys(action_workspaces).sort(function (a, b) { return a - b; });
  let prioritized_actions = [];
  _.each(priorities, function (p) {
    log.log("Replication: Priority %s has %s actions", p, action_workspaces[p].length);
    prioritized_actions = prioritized_actions.concat(_.shuffle(action_workspaces[p]));
  });

  prioritized_actions = prioritized_actions.slice(0, settings.actions_per_pass);

  setImmediate(function () {
    let timeout;
    let completed_actions = 0;
    log.log("Running %s actions.", prioritized_actions.length);
    async.eachLimit(prioritized_actions, settings.actions_outstanding, function (w, cb) {
      if (self.replicating) {
        return cb("Another replication started.");
      }
      w.cb = cb;
      if (!w.action) {
        // TODO: fix self.replicating
        return cb(util.format("Action for workspace %s deleted before we got to it. Probably a stupid race condition.", w.id));
      }
      w.action.f.call(self, w, function (err) {
        const action_name = w.action && w.action.name;
        if (err) {
          log.error("Workspace %s action %s: %s", w.id, action_name, err);
        }
        if (w.action) {
          w.action.running = false;
          self.action_history.push(w.action);
          delete w.action;
        } else {
          log.warn("Workspace %s: No action! Workspace must have been deleted.", w.id);
        }
        completed_actions++;
        // If no w.cb, timeout already called it
        if (!w.cb) {
          log.error("Workspace %s action %s callback already called.", w.id, action_name);
          return;
        }
        w.cb();
        delete w.cb;
      });
    }, function (err) {
      clearTimeout(timeout);
      self.action_history = self.action_history.slice(-100);
      log.log("Replication ran %s/%s actions.", completed_actions, prioritized_actions.length);

      self.replicate_interval_id = setTimeout(self.replicate.bind(self), settings.replicate_interval);
      if (err) {
        log.error(err);
        return;
      }
      last_rep.finished = Date.now();
      last_rep.completed_actions = completed_actions;
      last_rep.total_actions = prioritized_actions.length;
      self.last_rep = last_rep;
    });

    timeout = setTimeout(function () {
      let uncalled = 0;
      prioritized_actions.forEach(function (w) {
        if (!w.cb) {
          return;
        }
        ++uncalled;
        let action = w.action;
        if (w.action) {
          delete w.action;
        }
        w.cb(util.format("%s action %s timed out.", w.id, action && action.name));
        delete w.cb;
      });
      if (uncalled > 0) {
        log.error("%s uncalled actions", uncalled);
      }
    }, 60000);
  });

  self.replicating = false;
};

Master.prototype.async_each_slave = function (f, cb) {
  const self = this;
  let errs = [];
  async.each(_.values(self.slaves), function (slave, each_cb) {
    f(slave, function (err, result) {
      if (err) {
        log.error("Error async_each_slave for %s: %s", slave.toString(), err);
        errs.push(err);
      }
      // Squelch error so we don't abort in the middle
      return each_cb(null, result);
    });
  }, function (err, result) {
    if (err || errs.length > 0) {
      return cb(err || errs, result);
    }
    return cb(err, result);
  });
};

Master.prototype.stop = function () {
  const self = this;

  // TODO: save server mapping to disk!
  _.each(self.slaves, function (slave) {
    slave.disconnect("Master is stopping.");
  });

  if (self.replicate_interval_id) {
    clearTimeout(self.replicate_interval_id);
  }

  if (self.rebalance_interval_id) {
    clearTimeout(self.rebalance_interval_id);
  }

  self.api_server.set_controller(null);
};

module.exports = Master;
