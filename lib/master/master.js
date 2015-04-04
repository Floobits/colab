/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");
var actions = require("../actions");

var APIServer = require("./api_server");
var settings = require("../settings");


var Master = function () {
  var self = this;

  if (!_.isFinite(settings.repcount) || settings.repcount < 1) {
    throw new Error(util.format("settings.repcount is invalid: %s!", settings.repcount));
  }

  if (settings.log_level !== "debug") {
    if (settings.repcount < 3) {
      throw new Error("Production server, but repcount is less than 3. SHUT IT DOWN!");
    }
  }

  settings.actions_per_pass = settings.actions_per_pass || 100;

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

  self.api_server = new APIServer(self);

  self.backup = false;

  self.slaves = {};
  actions.slave.onADD(function (id, slave_handler) {
    self.slaves[id] = slave_handler;
    if (slave_handler.backup) {
      self.backup = true;
      log.log("%s is a backup server. Backups enabled.", slave_handler.toString());
    }
    // TODO: check connected slaves?
    if (_.size(self.slaves) >= settings.repcount && !self.api_server.listening) {
      log.log("%s slaves connected. Starting master API server...", _.size(self.slaves));
      self.api_server.listen(function (err) {
        if (err) {
          throw new Error(err);
        }
      });
    }
  });
  actions.slave.onUPDATE_COUNT(this.on_update_count, this);
  actions.slave.onCREATE_WORKSPACE(function (id, workspace) {
    var data = {
      id: workspace.id,
      slaves: {}
    };

    data.slaves[id] = {
      version: workspace.version || 0,
      active: workspace.active || false
    };
    self.workspaces[workspace.id] = data;
  });

  actions.conn.onEND(self.on_conn_end, this);
  actions.broadcast.onSEND_TO_SLAVES(this.on_send_to_slaves, this);
};

Master.prototype.on_send_to_slaves = function (data, send_cb) {
  this.async_each_slave(function (slave, cb) {
    slave.broadcast(data, cb);
  }, send_cb);
};

Master.prototype.on_update_count = function (id, workspaces) {
  var self = this,
    slave = self.slaves[id];

  log.log("Updating counts for %s", slave.toString());

  _.each(self.workspaces, function (w) {
    delete w.slaves[id];
  });

  _.each(workspaces, function (workspace) {
    var old_server, w;

    if (workspace.active) {
      // active workspace
      old_server = self.server_mapping.workspace[workspace.id];
      if (old_server && old_server.id !== slave.id) {
        // This should never happen
        log.error("OH NO! Workspace %s moved from %s to %s", workspace.id, old_server.id, slave.id);
        self.moved_workspaces.push({
          workspace: workspace,
          from: old_server.to_json(),
          to: slave.to_json()
        });
      }
      self.set_mapping(workspace.id, slave);
    }

    w = self.workspaces[workspace.id];
    if (!w) {
      w = {
        id: workspace.id,
        slaves: {}
      };
      self.workspaces[workspace.id] = w;
    }
    w.slaves[id] = {
      version: workspace.version,
      active: workspace.active
    };
    if (workspace.users) {
      w.slaves[id].users = workspace.users;
    }
  });
  self.moved_workspaces = self.moved_workspaces.slice(-100);
};

Master.prototype.on_conn_end = function (proto) {
  var self = this,
    slave,
    slave_id;

  if (!proto.handler) {
    return;
  }

  slave_id = proto.handler.id;
  slave = self.slaves[slave_id];
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
  self.backup = _.any(self.slaves, function (s) {
    return s.backup;
  });
  log.log("Backups %s", (self.backup ? "enabled" : "disabled"));
};

Master.prototype.start = function () {
  var self = this;

  self.replicate();

  if (_.isFinite(settings.rebalance_threshold) && settings.rebalance_threshold < 1) {
    self.rebalance();
  } else {
    log.warn("Rebalance threshold is %s. Rebalancing disabled.", settings.rebalance_threshold);
  }
};

Master.prototype.set_mapping = function (workspace_id, slave) {
  var self = this;

  self.server_mapping.workspace[workspace_id] = slave;
  self.workspace_mapping_age[workspace_id] = 0;
};

Master.prototype.find_server = function (namespace, key) {
  var self = this,
    slave = self.server_mapping[namespace][key],
    servers;

  if (slave) {
    log.debug("%s %s is on %s", namespace, key, slave.toString());
    return slave.conn_info();
  }

  servers = _.chain(self.slaves)
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
    var mem_free = server.load.memory.freemem / server.load.memory.totalmem,
      rss_used = server.load.memory.rss / server.load.memory.totalmem;
    return _.max(server.load.loadavg) < settings.busy.loadavg && mem_free > settings.busy.mem_free && rss_used < settings.busy.rss_used;
  });

  // Nothing good. just pick one
  if (slave) {
    log.debug("Picked %s for %s %s", slave.toString(), namespace, key);
  } else {
    slave = servers[0];
    log.warn("All servers are busy. Randomly picked %s for %s %s", slave.toString(), namespace, key);
  }

  // This looks dangerous, but find_server is only called with namespace of token or username
  self.server_mapping[namespace][key] = slave;

  return slave.conn_info();
};

Master.prototype.create_workspace = function (workspace_id, cb) {
  var self = this,
    slave,
    slaves;

  slaves = _.chain(self.slaves)
    .filter(function (server) { return !server.exclude; })
    .shuffle()
    .value();

  slave = _.find(slaves, function (server) {
    var mem_free = server.load.memory.freemem / server.load.memory.totalmem,
      rss_used = server.load.memory.rss / server.load.memory.totalmem;
    return _.max(server.load.loadavg) < settings.busy.loadavg && mem_free > settings.busy.mem_free && rss_used < settings.busy.rss_used;
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
  var self = this,
    candidates = {};

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
  var self = this,
    active,
    colab_version,
    source,
    source_id,
    source_version;

  _.shuffle(_.keys(workspace.slaves)).every(function (colab_id) {
    var colab = self.slaves[colab_id];
    colab_version = workspace.slaves[colab_id].version;
    active = workspace.slaves[colab_id].active;
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
  var self = this,
    active,
    colab_version,
    dest,
    dest_id,
    source,
    source_id,
    source_version;

  _.shuffle(_.keys(workspace.slaves)).every(function (colab_id) {
    var colab = self.slaves[colab_id];
    colab_version = workspace.slaves[colab_id].version;
    active = workspace.slaves[colab_id].active;
    log.debug("Potential source for %s: %s version %s active %s", workspace.id, colab.toString(), colab_version, active);

    if (colab.disconnected) {
      log.debug("Skipping source %s for %s: Slave is not connected (%s)", colab.toString(), workspace.id, colab.disconnected);
      return true;
    }
    if (colab.exclude) {
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

  _.each(_.shuffle(_.keys(workspace.slaves)), function (colab_id) {
    var colab = workspace.slaves[colab_id],
      scolab = self.slaves[colab_id];
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
      if (colab.exclude || colab.disconnected || _.contains(_.keys(workspace.slaves), colab.id)) {
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
  var self = this,
    colab,
    colab_id;

  _.each(_.shuffle(_.keys(workspace.slaves)), function (candidate_id) {
    var candidate = workspace.slaves[candidate_id];
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
  var self = this,
    colab_id = colab.id,
    colab_version = workspace.slaves[colab_id].version;

  workspace.action.running = true;

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
  var self = this,
    move;

  log.debug("Moving workspace %s from %s to %s", workspace.id, source.toString(), dest.toString());

  move = [
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
  var self = this,
    filtered_mapping = {};

  server.exclude = true;

  // TODO: disconnect users on drained server
  _.each(self.server_mapping, function (mapping, key) {
    filtered_mapping[key] = _.filter(mapping, function (v) {
      return v.ip !== server.ip;
    });
  });
  self.server_mapping = filtered_mapping;
};

Master.prototype.rebalance = function () {
  var self = this,
    avg_usage,
    slaves,
    low = [],
    high = [],
    tot_usage = 0;

  slaves = _.filter(self.slaves, function (slave) {
    return !slave.exclude;
  });

  _.each(slaves, function (slave) {
    log.debug("%s disk usage is %s", slave.toString(), slave.load.disk.usage);
    if (!_.isFinite(slave.load.disk.usage)) {
      return;
    }
    tot_usage += slave.load.disk.usage;
  });
  avg_usage = tot_usage / _.size(slaves);
  log.debug("Average usage: %s", avg_usage);

  _.each(slaves, function (slave, slave_id) {
    var diff = slave.load.disk.usage - avg_usage;
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
    var colab_workspaces;
    colab = slaves[colab];
    log.debug("Rebalancing %s", colab.toString());
    colab_workspaces = _.filter(self.workspaces, function (w) {
      return !!w.slaves[colab.id];
    });
    async.forEach(_.sample(colab_workspaces, 50), function (w, cb) {
      var candidates,
        dest;
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
      dest = _.sample(candidates);
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
    self.rebalance_interval_id = setTimeout(self.rebalance.bind(self), 6000);
  });
};

Master.prototype.replicate = function () {
  var self = this,
    action_workspaces = {},
    completed_actions = 0,
    last_rep = {},
    priorities,
    prioritized_actions = [],
    stats = {
      correct: 0,
      high: 0,
      low: 0,
      running: 0,
    };

  if (self.replicating) {
    log.warn("Replication already running. Started %sms ago", Date.now() - self.last_rep.started);
    return;
  }
  log.log("Replicating");

  clearTimeout(self.replicate_interval_id);
  self.replicate_interval_id = null;
  self.replicating = true;
  last_rep.started = Date.now();

  _.each(self.workspaces, function (w, id) {
    var active = false,
      backup_repcount = 0,
      exclude_repcount = 0,
      high_repcount,
      priority,
      repcount = 0,
      version;

    // TODO: split this out into its own function
    _.each(w.slaves, function (colab, slave_id) {
      var slave = self.slaves[slave_id];

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
      if (version < colab.version) {
        log.debug("Workspace %s has different versions: %s %s", id, version, colab.version);
        version = colab.version;
        return;
      }
      if (version > colab.version) {
        log.debug("Workspace %s has different versions: %s %s", id, version, colab.version);
        return;
      }
      if (slave.disconnected && last_rep.started - slave.disconnected > settings.slave_error_threshold) {
        log.debug("Slave %s disconnected too long ago: %sms ago.", slave_id, (last_rep.started - slave.disconnected));
        if (self.server_mapping.workspace[id] && slave_id === self.server_mapping.workspace[id].id) {
          delete self.server_mapping.workspace[id];
          delete self.workspace_mapping_age[id];
        }
        if (colab.active) {
          colab.active = false;
        }
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
      return;
    }

    // high_repcount includes replicas that are old versions
    high_repcount = _.size(w.slaves) - backup_repcount - exclude_repcount;

    if (self.backup && backup_repcount === 0) {
      log.debug("Workspace %s has %s backups (not enough).", id, backup_repcount);
      w.action = {
        f: function (workspace, cb) {
          var candidates;
          try {
            candidates = self.get_backup_candidates(workspace);
          } catch (e) {
            log.error("Error getting backup candidates for %s: %s", id, e.toString());
          }
          if (!candidates) {
            return cb(util.format("No candidates to backup %s to!", id));
          }
          workspace.action.to = candidates.dest.id;
          workspace.action.from = candidates.source.id;
          self.copy_workspace(workspace, candidates.source, candidates.dest, cb);
        },
        name: "backup",
        workspace_id: id,
        running: false
      };
      priority = 1;
    } else if (repcount === 0) {
      log.error("Repcount for %s is ZERO!", id);
      stats.low++;
    } else if (repcount < settings.repcount) {
      log.debug("Workspace %s has %s replicas (not enough).", id, repcount);
      stats.low++;
      w.action = {
        f: function (workspace, cb) {
          var candidates;
          try {
            candidates = self.get_copy_candidates(workspace);
          } catch (e) {
            log.error("Error getting copy candidates for %s: %s", id, e.toString());
          }
          if (!candidates) {
            return cb(util.format("No candidates to copy %s to!", id));
          }
          workspace.action.to = candidates.dest.id;
          workspace.action.from = candidates.source.id;
          self.copy_workspace(workspace, candidates.source, candidates.dest, cb);
        },
        name: "copy",
        workspace_id: id,
        running: false
      };
    } else if (high_repcount > settings.repcount) {
      stats.high++;
      log.debug("Workspace %s has %s replicas (too many).", id, high_repcount);
      w.action = {
        f: function (workspace, cb) {
          var candidate;
          try {
            candidate = self.get_del_candidate(workspace);
          } catch (e) {
            log.error("Error getting del candidate for %s: %s", id, e.toString());
          }
          if (!candidate) {
            return cb(util.format("No canditate found to delete %s from.", id));
          }
          workspace.action.to = candidate.id;
          self.delete_workspace(workspace, candidate, cb);
        },
        name: "delete",
        workspace_id: id,
        running: false
      };
    } else {
      stats.correct++;
      if (w.action && _.contains(["copy", "delete"], w.action.name) && !w.action.running) {
        log.log("Cancelling action %s on %s", w.action.name, w.id);
        delete w.action;
      }
    }
    if (w.action) {
      priority = priority || Math.abs(repcount - settings.repcount) + !!_.findWhere(w.slaves, { active: true });
      action_workspaces[priority] = action_workspaces[priority] || [];
      action_workspaces[priority].push(w);
    }
  });
  log.log("Workspace replication counts: %s running. %s low. %s high. %s correct.", stats.running, stats.low, stats.high, stats.correct);
  self.workspace_stats = stats;

  priorities = _.keys(action_workspaces).sort(function (a, b) { return a - b; });

  _.each(priorities, function (p) {
    prioritized_actions = prioritized_actions.concat(_.shuffle(action_workspaces[p]));
  });

  prioritized_actions = prioritized_actions.slice(0, settings.actions_per_pass);

  setImmediate(function () {
    let timeout;
    log.log("Running %s actions.", prioritized_actions.length);
    async.eachLimit(prioritized_actions, 20, function (w, cb) {
      if (self.replicating) {
        return cb("Another replication started.");
      }
      w.cb = cb;
      w.action.f.call(self, w, function (err) {
        if (err) {
          log.error("Error in action on workspace %s: %s", w.id, err);
        }
        if (w.action) {
          w.action.running = false;
          self.action_history.push(w.action);
          delete w.action;
        } else {
          log.warn("No action for %s. Workspace must have been deleted.", w.id);
        }
        completed_actions++;
        // If no w.cb, timeout already called it
        if (!w.cb) {
          log.error("%s %s callback already called", w.id, w.action && w.action.name);
          return;
        }
        w.cb();
        delete w.cb;
      });
    }, function (err) {
      clearTimeout(timeout);
      self.action_history = self.action_history.slice(-100);
      log.log("Replication ran %s/%s actions.", completed_actions, prioritized_actions.length);

      self.replicate_interval_id = setTimeout(self.replicate.bind(self), 20000);
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
    }, 300000);
  });

  self.replicating = false;
};

Master.prototype.async_each_slave = function (f, cb) {
  var self = this;
  async.each(_.values(self.slaves), function (slave, each_cb) {
    f(slave, function (err, result) {
      if (err) {
        log.error("Error async_each_slave for %s: %s", slave.toString(), err);
      }
      // Squelch error so we don't abort in the middle
      return each_cb(null, result);
    });
  }, cb);
};

Master.prototype.stop = function (cb) {
  var self = this;

  cb = cb || function () { return; };

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

  self.api_server.stop(cb);
};


exports.run = function (cb) {
  var master = new Master();
  master.start();
  return cb(null, master);
};
