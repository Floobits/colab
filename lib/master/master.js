/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var fs = require("fs");
var http = require("http");
var https = require("https");
var util = require("util");

var async = require("async");
var express = require("express");
var log = require("floorine");
var request = require("request");
var _ = require("lodash");
var actions = require("../actions");

var APIServer = require("./api_server");
var cache = require("./cache");
var db = require("./db");
var settings = require("../settings");

request = request.defaults(settings.request_defaults);

var AUTH_USER = settings.auth.username;
var AUTH_PASS = settings.auth.password;


var Master = function () {
  var self = this;

  if (!_.isFinite(settings.repcount) || settings.repcount < 1) {
    log.error("settings.repcount is invalid: %s!", settings.repcount);
    return process.exit(1);
  }

  if (settings.log_level !== "debug") {
    if (settings.repcount < 3) {
      log.error("Production server and repcount is less than 3. SHUT IT DOWN!");
      return process.exit(1);
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

  self.slaves = {};
  actions.slave.onADD(function (id, slave_handler) {
    self.slaves[id] = slave_handler;
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

    if (workspace.owner && workspace.name) {
      // active workspace
      old_server = self.server_mapping.workspace[workspace.id];
      if (old_server && old_server.id !== slave.id) {
        // This should never happen
        log.error("OH NO! Workspace moved from %s to %s", old_server.id, slave.id);
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
  self.update_memcached_workspaces();
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

  delete self.slaves[slave_id];
  _.each(self.workspaces, function (w) {
    delete w.slaves[slave_id];
  });
  log.warn("Slave %s disconnected. Repcounts updated.");
};

Master.prototype.start = function () {
  var self = this;

  self.api_server.listen(function (err) {
    if (err) {
      process.exit(1);
    }
    self.replicate();

    if (_.isFinite(settings.rebalance_threshold) && settings.rebalance_threshold < 1) {
      self.rebalance();
    } else {
      log.warn("Rebalance threshold is %s. Rebalancing disabled.", settings.rebalance_threshold);
    }
  });
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
    return {
      ip: slave.ip,
      port: slave.colab_port,
      ssl: slave.ssl
    };
  }

  servers = _.chain(self.slaves)
    .filter(function (server) {
      if (server.exclude) {
        return false;
      }
      if (server.poller.errors > 0) {
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

  return {
    ip: slave.ip,
    port: slave.colab_port,
    ssl: slave.ssl
  };
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

  slave.create_workspace(workspace_id, 0, cb);
};

Master.prototype.evict_workspace = function (server, workspace_id, cb) {
  var options = {
      auth: {
        user: AUTH_USER,
        password: AUTH_PASS
      },
      json: true,
      rejectUnauthorized: false
    },
    url = util.format("%s://%s:%s/workspace/%s/evict", (server.ssl ? "https" : "http"), server.ip, server.api_port, workspace_id);

  request.post(url, options, function (err, response, body) {
    if (err) {
      log.error(err);
      return cb(500, err);
    }

    log.debug("Response from evict %s: %s", url, body);

    if (response.statusCode >= 400) {
      return cb(response.statusCode, util.format("Status code %s from %s", response.statusCode, url));
    }

    return cb(null, body);
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

    // Last poll failed. Skip.
    if (colab.errors > 0) {
      log.debug("Skipping source %s for %s: Too many errors (%s)", colab.toString(), workspace.id, colab.errors);
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
      source_id = colab_id;
      log.debug("Selected active source %s for %s.", source.toString(), workspace.id);
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

    // Last poll failed. Skip.
    if (colab.errors > 0) {
      log.debug("Skipping source %s for %s: Too many errors (%s)", colab.toString(), workspace.id, colab.errors);
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
      source_id = colab_id;
      log.debug("Selected active source %s for %s.", source.toString(), workspace.id);
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
    if (scolab && (scolab.exclude || scolab.errors > 0)) {
      // Last poll failed. Skip.
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
      if (colab.errors > 0 || _.contains(_.keys(workspace.slaves), colab.id)) {
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
  var options = {
      auth: {
        user: AUTH_USER,
        password: AUTH_PASS
      },
      rejectUnauthorized: false
    },
    url;

  workspace.action.running = true;
  log.log("Copying %s from %s to %s.", workspace.id, source.toString(), dest.toString());
  url = util.format("%s://%s:%s/fetch/%s", (dest.ssl ? "https" : "http"), dest.ip, dest.api_port, workspace.id);

  options.json = {
    // TODO: make this decision when picking candidates
    ip: dest.backup ? source.external_ip : source.ip,
    port: source.api_port,
    proto: source.ssl ? "https" : "http"
  };

  cb = cb || function (err) {
    if (err) {
      log.error(err);
    }
  };

  request.post(url, options, function (err, response, body) {
    if (err) {
      log.error(err);
      return cb(500, err);
    }

    log.debug("Response from POST %s: %s", url, JSON.stringify(body));

    if (response.statusCode >= 400) {
      return cb(response.statusCode, util.format("Status code %s from %s", response.statusCode, url));
    }

    if (!dest.id) {
      return cb(util.format("Destination %s has no id!", dest.toString()));
    }
    workspace.slaves[dest.id] = {
      version: body.version,
      active: body.active
    };

    return cb(null, body);
  });
};

Master.prototype.get_del_candidate = function (workspace) {
  var self = this,
    colab,
    colab_id;

  _.each(_.shuffle(_.keys(workspace.slaves)), function (candidate_id) {
    var candidate = workspace.slaves[candidate_id];
    log.debug("Candidate: %s %s. colab: %s %s", candidate_id, JSON.stringify(candidate), colab_id, JSON.stringify(colab));
    if (candidate.active) {
      log.debug("Not deleting workspace %s from colab %s because it's active.", workspace.id, candidate_id);
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
    colab_version = workspace.slaves[colab_id].version,
    options = {
      auth: {
        user: AUTH_USER,
        password: AUTH_PASS
      },
      json: true,
      rejectUnauthorized: false
    },
    url;

  workspace.action.running = true;

  // Reduce repcount immediately. If delete fails, slave will re-send workspace info and we'll pick it up again.
  delete workspace.slaves[colab_id];

  log.log("Deleting %s version %s from %s.", workspace.id, colab_version, colab.toString());

  url = util.format("%s://%s:%s/workspace/%s", (colab.ssl ? "https" : "http"), colab.ip, colab.api_port, workspace.id);

  cb = cb || function (err) {
    if (err) {
      log.error(err);
    }
  };

  request.del(url, options, function (err, response, body) {
    delete workspace.slaves[colab_id];
    if (err) {
      log.error(err);
      return cb(500, err);
    }

    log.debug("Response from DELETE %s: %s", url, body);

    if (response.statusCode >= 400) {
      return cb(response.statusCode, util.format("Status code %s from %s", response.statusCode, url));
    }

    if (_.size(workspace.slaves) === 0) {
      // No more copies. Completely delete workspace.
      delete self.workspaces[workspace.id];
      delete self.server_mapping.workspace[workspace.id];
      delete self.workspace_mapping_age[workspace.id];
    }

    return cb(null, body);
  });
};

Master.prototype.move_workspace = function (workspace, source, dest, cb) {
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
  async.series(move, cb);
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
  async.forEach(high, function (colab, cb) {
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
      return cb(err, result);
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
      running: 0
    };

  self.replicate_interval_id = null;
  self.replicating = true;
  last_rep.started = Date.now();

  _.each(self.workspaces, function (w, id) {
    var active = false,
      backup_repcount = 0,
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
      if (slave.errors > settings.colab_error_threshold) {
        log.debug("Colab %s errors too high: %s", slave_id, slave.errors);
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

    if (self.backup && backup_repcount === 0) {
      log.debug("Workspace %s has %s backups (not enough).", id, backup_repcount);
      w.action = {
        f: function (w, cb) {
          var candidates;
          try {
            candidates = self.get_backup_candidates(w);
          } catch (e) {
            log.error("Error getting backup candidates for %s: %s", id, e.toString());
          }
          if (!candidates) {
            return cb(util.format("No candidates to backup %s to!", id));
          }
          w.action.to = candidates.dest.id;
          w.action.from = candidates.source.id;
          self.copy_workspace(w, candidates.source, candidates.dest, cb);
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
        f: function (w, cb) {
          var candidates;
          try {
            candidates = self.get_copy_candidates(w);
          } catch (e) {
            log.error("Error getting copy candidates for %s: %s", id, e.toString());
          }
          if (!candidates) {
            return cb(util.format("No candidates to copy %s to!", id));
          }
          w.action.to = candidates.dest.id;
          w.action.from = candidates.source.id;
          self.copy_workspace(w, candidates.source, candidates.dest, cb);
        },
        name: "copy",
        workspace_id: id,
        running: false
      };
    } else if (repcount > settings.repcount || _.size(w.slaves) - backup_repcount > settings.repcount) {
      stats.high++;
      log.debug("Workspace %s has %s replicas (too many).", id, repcount > _.size(w.slaves) ? repcount : _.size(w.slaves));
      w.action = {
        f: function (w, cb) {
          var candidate;
          try {
            candidate = self.get_del_candidate(w);
          } catch (e) {
            log.error("Error getting del candidate for %s: %s", id, e.toString());
          }
          if (!candidate) {
            return cb(util.format("No canditate found to delete %s from.", id));
          }
          w.action.to = candidate.id;
          self.delete_workspace(w, candidate, cb);
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
    log.log("Running %s actions.", prioritized_actions.length);
    async.eachLimit(prioritized_actions, 20, function (w, cb) {
      if (self.replicating) {
        return cb("Another replication started.");
      }
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
        cb();
      });
    }, function (err) {
      self.action_history = self.action_history.slice(-100);
      log.log("Ran %s/%s actions.", completed_actions, prioritized_actions.length);

      if (err) {
        log.error(err);
        return;
      }
      last_rep.finished = Date.now();
      last_rep.completed_actions = completed_actions;
      last_rep.total_actions = prioritized_actions.length;
      self.last_rep = last_rep;
      self.replicate_interval_id = setTimeout(self.replicate.bind(self), 5000);
    });
  });

  self.replicating = false;
  self.update_memcached_users();
};

Master.prototype.update_memcached_users = function () {
  var self = this,
    user_mapping = {};

  _.each(self.slaves, function (slave) {
    _.each(slave.active_workspaces, function (workspace) {
      _.each(workspace.users, function (user) {
        var user_id = user.user_id;

        if (user_id < 0) {
          return;
        }
        if (_.has(user_mapping, user_id)) {
          user_mapping[user_id].push(workspace.id);
        } else {
          user_mapping[user_id] = [workspace.id];
        }
      });
    });
  });

  _.each(user_mapping, function (workspaces, user_id) {
    cache.set(util.format("now_editing_user_%s", user_id), workspaces, {flags: 0, exptime: 60});
  });
};

Master.prototype.update_memcached_workspaces = function () {
  var self = this,
    workspaces = self.workspaces,
    active_workspaces = [];

  _.each(self.server_mapping.workspace, function (server, workspace_id) {
    var workspace;
    // Awesome
    // TODO: figure out WTF is actually breaking here
    try {
      workspace = workspaces[workspace_id].slaves[server.id];
      active_workspaces.push({
        server: server.name,
        id: parseInt(workspace_id, 10),
        users: workspace.users
      });
      if (workspace.users) {
        cache.set(util.format("active_users_%s", workspace_id), workspace.users, {flags: 0, exptime: 30});
      } else {
        cache.del(util.format("active_users_%s", workspace_id));
      }
    } catch (e) {
      log.error("Error updating cache for %s: %s", workspace_id, e);
    }
  });

  cache.set("active_workspaces", active_workspaces, function (err) {
    if (err) {
      log.error("Error setting active_workspaces in memcached:", err);
    } else {
      log.debug("Set active_workspaces to", active_workspaces);
    }
  });
};

Master.prototype.async_each_slave = function (f, cb) {
  var self = this;
  async.each(_.values(self.colab_servers), f, cb);
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

  self.api_server.stop(function (err) {
    db.end();
    cb(err);
  });
};


exports.run = function (cb) {
  var master = new Master();

  function finish(err) {
    if (err) {
      log.error(err);
      process.exit(1);
    }
    master.start();
    return cb(null, master);
  }

  if (settings.cache_servers) {
    cache.connect(finish);
    return;
  }
  log.warn("No cache settings. Not connecting to cache.");
  finish();

  // TODO: do these things on colab connect
  // _.each(settings.slaves, function (colab_settings) {
  //   slaves.push(new colab.Colab(master, colab_settings));
  // });
  // Only enable backup behavior if we have a backup server configured.
  // master.backup = _.size(_.filter(master.slaves, function (server) {
  //   return server.backup;
  // }));
  // log.log("Polling servers...");
};
