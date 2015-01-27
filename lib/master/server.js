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

var APIServer = require("./api_server");
var cache = require("./cache");
var colab = require("./colab");
var db = require("./db");
var settings = require("../settings");

request = request.defaults(settings.request_defaults);

var AUTH_USER = settings.auth.username;
var AUTH_PASS = settings.auth.password;

/* TODO: split this file up!
   probably into separate files for http interface, polling, and ensuring repcount
 */

var ColabControlServer = function () {
  var self = this,
    active_count = _.size(_.where(settings.colab_servers, function (s) { return !s.exclude; }));

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

  if (settings.repcount > active_count) {
    log.error("Repcount (%s) is greater than the number of available colab servers (%s)!", settings.repcount, settings.colab_servers.length);
    return process.exit(1);
  }

  self.server_mapping = {
    "token": {},
    "workspace": {},
    "username": {}
  };
  self.workspace_mapping_age = {};

  // {
  //   id: 10,
  //   colabs: {
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
  self.colab_servers = {};

  self.replicate_interval_id = null;
  // Info about the most recent replication. (start/end time, success/failures, etc)
  self.last_rep = {};
  self.action_history = [];

  self.api_server = new APIServer(self);
};


ColabControlServer.prototype.start = function () {
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

ColabControlServer.prototype.set_mapping = function (workspace_id, colab) {
  var self = this;

  self.server_mapping.workspace[workspace_id] = colab;
  self.workspace_mapping_age[workspace_id] = 0;
};

ColabControlServer.prototype.find_server = function (namespace, key) {
  var self = this,
    colab_server = self.server_mapping[namespace][key],
    servers;

  if (colab_server) {
    log.debug("%s %s is on %s:%s", namespace, key, colab_server.ip, colab_server.colab_port);
    return {
      ip: colab_server.ip,
      port: colab_server.colab_port,
      ssl: colab_server.ssl
    };
  }

  servers = _.chain(self.colab_servers)
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

  colab_server = _.find(servers, function (server) {
    var mem_free = server.load.memory.freemem / server.load.memory.totalmem,
      rss_used = server.load.memory.rss / server.load.memory.totalmem;
    return _.max(server.load.loadavg) < settings.busy.loadavg && mem_free > settings.busy.mem_free && rss_used < settings.busy.rss_used;
  });

  // Nothing good. just pick one
  if (colab_server) {
    log.debug("Picked %s:%s for %s %s", colab_server.ip, colab_server.colab_port, namespace, key);
  } else {
    colab_server = servers[0];
    log.warn("All servers are busy. Randomly picked %s:%s for %s %s", colab_server.ip, colab_server.colab_port, namespace, key);
  }

  // This looks dangerous, but find_server is only called with namespace of token or username
  self.server_mapping[namespace][key] = colab_server;

  return {
    ip: colab_server.ip,
    port: colab_server.colab_port,
    ssl: colab_server.ssl
  };
};

ColabControlServer.prototype.create_workspace = function (workspace_id, atts, cb) {
  var self = this,
    colab,
    options = {
      auth: {
        user: AUTH_USER,
        password: AUTH_PASS
      },
      rejectUnauthorized: false
    },
    servers,
    url;

  if (_.isFunction(atts)) {
    cb = atts;
    atts = {};
  }

  servers = _.chain(self.colab_servers)
    .filter(function (server) { return !server.exclude; })
    .shuffle()
    .value();

  colab = _.find(servers, function (server) {
    var mem_free = server.load.memory.freemem / server.load.memory.totalmem,
      rss_used = server.load.memory.rss / server.load.memory.totalmem;
    return _.max(server.load.loadavg) < settings.busy.loadavg && mem_free > settings.busy.mem_free && rss_used < settings.busy.rss_used;
  });

  // Nothing good. just pick one
  if (colab) {
    log.debug("Picked %s:%s for workspace %s", colab.ip, colab.colab_port, workspace_id);
  } else {
    colab = servers[0];
    log.warn("All servers are busy. Randomly picked %s:%s for workspace %s", colab.ip, colab.colab_port, workspace_id);
  }

  url = util.format("%s://%s:%s/workspace/%s", (colab.ssl ? "https" : "http"), colab.ip, colab.api_port, workspace_id);
  options.json = atts || {};
  request.post(url, options, function (err, response, body) {
    var workspace = {
      id: workspace_id,
      colabs: {}
    };

    if (err) {
      return cb(err);
    }
    if (response.statusCode >= 400) {
      return cb(util.format("Code %s from %s", response.statusCode, url), body);
    }
    workspace.colabs[colab.id] = {
      version: body.version || 0,
      active: body.active || false
    };
    self.workspaces[workspace_id] = workspace;
    return cb(null, workspace);
  });
};

ColabControlServer.prototype.evict_workspace = function (server, workspace_id, cb) {
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

ColabControlServer.prototype.get_backup_candidates = function (workspace) {
  var self = this,
    candidates = {};

  candidates.source = self.get_source(workspace);
  candidates.dest = _.filter(self.colab_servers, function (colab) {
    return colab.backup;
  });

  if (candidates.dest.length === 0) {
    throw new Error(util.format("Couldn't find a backup server for %s", workspace.id));
  }

  candidates.dest = candidates.dest[0];

  return candidates;
};

ColabControlServer.prototype.get_source = function (workspace) {
  var self = this,
    active,
    colab_version,
    source,
    source_id,
    source_version;

  _.shuffle(_.keys(workspace.colabs)).every(function (colab_id) {
    var colab = self.colab_servers[colab_id];
    colab_version = workspace.colabs[colab_id].version;
    active = workspace.colabs[colab_id].active;
    log.debug("Potential source for %s: %s version %s active %s", workspace.id, colab.ip, colab_version, active);

    // Last poll failed. Skip.
    if (colab.poller.errors > 0) {
      log.debug("Skipping source %s for %s: Too many poller errors (%s)", colab.ip, workspace.id, colab.poller.errors);
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
      log.debug("Selected active source %s for %s.", source.ip, workspace.id);
      return false;
    }
    if (colab_version > source_version) {
      log.debug("Source for %s: %s version %s > %s %s.", workspace.id, colab.ip, colab_version, source.ip, source_version);
      source = colab;
      source_id = colab_id;
      source_version = colab_version;
    }
    return true;
  });

  source = self.colab_servers[source_id];
  if (!source) {
    throw new Error(util.format("Couldn't find a source for %s", workspace.id));
  }
  return source;
};

ColabControlServer.prototype.get_copy_candidates = function (workspace) {
  var self = this,
    active,
    colab_version,
    dest,
    dest_id,
    source,
    source_id,
    source_version;

  _.shuffle(_.keys(workspace.colabs)).every(function (colab_id) {
    var colab = self.colab_servers[colab_id];
    colab_version = workspace.colabs[colab_id].version;
    active = workspace.colabs[colab_id].active;
    log.debug("Potential source for %s: %s version %s active %s", workspace.id, colab.ip, colab_version, active);

    // Last poll failed. Skip.
    if (colab.poller.errors > 0) {
      log.debug("Skipping source %s for %s: Too many poller errors (%s)", colab.ip, workspace.id, colab.poller.errors);
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
      log.debug("Selected active source %s for %s.", source.ip, workspace.id);
      return false;
    }
    if (colab_version > source_version) {
      log.debug("Source for %s: %s version %s > %s %s.", workspace.id, colab.ip, colab_version, source.ip, source_version);
      source = colab;
      source_id = colab_id;
      source_version = colab_version;
    }
    return true;
  });

  source = self.colab_servers[source_id];
  if (!source) {
    throw new Error(util.format("Couldn't find a source for %s", workspace.id));
  }

  _.each(_.shuffle(_.keys(workspace.colabs)), function (colab_id) {
    var colab = workspace.colabs[colab_id],
      scolab = self.colab_servers[colab_id];
    if (scolab && (scolab.exclude || scolab.poller.errors > 0)) {
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
    if (scolab.load.disk.usage < self.colab_servers[dest_id].load.disk.usage) {
      log.debug("Picked %s because it has lower disk than %s", scolab.toString(), self.colab_servers[dest_id].toString());
      dest = colab;
      dest_id = colab_id;
    }
  });

  /* Warning: If only two copies exist and one is old, we could only have a repcount of 2
     for a long time (assuming the workspace is being edited).
   */
  if (!dest) {
    _.each(_.shuffle(_.values(self.colab_servers)), function (colab) {
      if (colab.poller.errors > 0 || _.contains(_.keys(workspace.colabs), colab.id)) {
        return;
      }
      if (!dest) {
        dest = colab;
        dest_id = colab.id;
      }
    });
  }

  dest = self.colab_servers[dest_id];
  if (!dest) {
    throw new Error(util.format("Couldn't find a destination for %s", workspace.id));
  }

  return {
    source: source,
    dest: dest
  };
};

ColabControlServer.prototype.copy_workspace = function (workspace, source, dest, cb) {
  var options = {
      auth: {
        user: AUTH_USER,
        password: AUTH_PASS
      },
      rejectUnauthorized: false
    },
    url;

  workspace.action.running = true;
  log.log("Copying %s from %s to %s.", workspace.id, source.ip, dest.ip);
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
    workspace.colabs[dest.id] = {
      version: body.version,
      active: body.active
    };

    return cb(null, body);
  });
};

ColabControlServer.prototype.get_del_candidate = function (workspace) {
  var self = this,
    colab,
    colab_id;

  _.each(_.shuffle(_.keys(workspace.colabs)), function (candidate_id) {
    var candidate = workspace.colabs[candidate_id];
    log.debug("Candidate: %s %s. colab: %s %s", candidate_id, JSON.stringify(candidate), colab_id, JSON.stringify(colab));
    if (candidate.active) {
      log.debug("Not deleting workspace %s from colab %s because it's active.", workspace.id, candidate_id);
      return;
    }
    if (self.colab_servers[candidate_id].exclude) {
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

  colab = self.colab_servers[colab_id];
  if (!colab) {
    throw new Error(util.format("No candidate to delete %s from.", workspace.id));
  }
  return colab;
};

ColabControlServer.prototype.delete_workspace = function (workspace, colab, cb) {
  var self = this,
    colab_id = colab.id,
    colab_version = workspace.colabs[colab_id].version,
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

  // Reduce repcount immediately. If delete fails, poller will pick it up again.
  delete workspace.colabs[colab_id];

  log.log("Deleting %s version %s from %s.", workspace.id, colab_version, colab.ip);

  url = util.format("%s://%s:%s/workspace/%s", (colab.ssl ? "https" : "http"), colab.ip, colab.api_port, workspace.id);

  cb = cb || function (err) {
    if (err) {
      log.error(err);
    }
  };

  request.del(url, options, function (err, response, body) {
    delete workspace.colabs[colab_id];
    if (err) {
      log.error(err);
      return cb(500, err);
    }

    log.debug("Response from DELETE %s: %s", url, body);

    if (response.statusCode >= 400) {
      return cb(response.statusCode, util.format("Status code %s from %s", response.statusCode, url));
    }

    if (_.size(workspace.colabs) === 0) {
      // No more copies. Completely delete workspace.
      delete self.workspaces[workspace.id];
      delete self.server_mapping.workspace[workspace.id];
      delete self.workspace_mapping_age[workspace.id];
    }

    return cb(null, body);
  });
};

ColabControlServer.prototype.move_workspace = function (workspace, source, dest, cb) {
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

ColabControlServer.prototype.drain = function (server) {
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

ColabControlServer.prototype.rebalance = function () {
  var self = this,
    avg_usage,
    colab_servers,
    low = [],
    high = [],
    tot_usage = 0;

  colab_servers = _.filter(self.colab_servers, function (colab) {
    return !colab.exclude;
  });

  _.each(colab_servers, function (colab) {
    log.debug("%s disk usage is %s", colab.toString(), colab.load.disk.usage);
    if (!_.isFinite(colab.load.disk.usage)) {
      return;
    }
    tot_usage += colab.load.disk.usage;
  });
  avg_usage = tot_usage / _.size(colab_servers);
  log.debug("Average usage: %s", avg_usage);

  _.each(colab_servers, function (colab, colab_id) {
    var diff = colab.load.disk.usage - avg_usage;
    if (diff > settings.rebalance_threshold) {
      log.debug("%s high diff %s", colab.toString(), diff);
      high.push(colab_id);
    } else if (diff < (-1 * settings.rebalance_threshold)) {
      low.push(colab_id);
      log.debug("%s low diff %s", colab.toString(), diff);
    }
  });

  log.log("Rebalancing: %s low, %s high.", _.size(low), _.size(high));
  async.forEach(high, function (colab, cb) {
    var colab_workspaces;
    colab = colab_servers[colab];
    log.debug("Rebalancing %s", colab.toString());
    colab_workspaces = _.filter(self.workspaces, function (w) {
      return !!w.colabs[colab.id];
    });
    async.forEach(_.sample(colab_workspaces, 50), function (w, cb) {
      var candidates,
        dest;
      if (w.action) {
        log.log("Can't rebalance %s on %s: Action %s is %s.", w.id, colab.toString(), w.action.name, (w.action.running ? "running" : "not running"));
        return cb();
      }
      if (w.colabs[colab.id].active) {
        log.log("Can't rebalance %s on %s because it's active.", w.id, colab.toString());
        return cb();
      }
      if (_.size(w.colabs) < settings.repcount) {
        log.log("Can't rebalance %s on %s because repcount is low.", w.id, colab.toString());
        return cb();
      }
      if (_.size(low) > 0) {
        candidates = _.map(low, function (c) {
          return colab_servers[c];
        });
      } else {
        candidates = _.values(colab_servers);
      }
      candidates = _.filter(candidates, function (c) {
        if (!c.id || c.id === colab.id) {
          return false;
        }
        // Don't try to copy to a colab that already has this workspace
        if (w.colabs[c.id]) {
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

ColabControlServer.prototype.replicate = function () {
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
    _.each(w.colabs, function (colab, colab_id) {
      var scolab = self.colab_servers[colab_id];
      if (!_.isFinite(colab.version)) {
        log.warn("Workspace %s has bad version (%s) on colab %s", id, colab.version, scolab.ip);
        log.warn("Workspace object in question: %s", JSON.stringify(w));
        return;
      }
      if (!_.isFinite(version)) {
        version = colab.version;
      }
      if (!scolab) {
        log.warn("No source colab with id %s", colab_id);
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
      if (scolab.poller.errors > settings.colab_error_threshold) {
        log.debug("Colab %s poller errors too high: %s", colab_id, scolab.poller.errors);
        if (self.server_mapping.workspace[id] && colab_id === self.server_mapping.workspace[id].id) {
          delete self.server_mapping.workspace[id];
          delete self.workspace_mapping_age[id];
        }
        if (colab.active) {
          colab.active = false;
        }
        return;
      }
      if (scolab.backup) {
        backup_repcount++;
        return;
      }
      if (scolab.exclude) {
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
    } else if (repcount > settings.repcount || _.size(w.colabs) - backup_repcount > settings.repcount) {
      stats.high++;
      log.debug("Workspace %s has %s replicas (too many).", id, repcount > _.size(w.colabs) ? repcount : _.size(w.colabs));
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
      priority = priority || Math.abs(repcount - settings.repcount) + !!_.findWhere(w.colabs, { active: true });
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
  self.update_memcached();
};

ColabControlServer.prototype.update_memcached = function () {
  var self = this,
    user_mapping = {};

  _.each(self.colab_servers, function (colab) {
    _.each(colab.active_workspaces, function (workspace) {
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

ColabControlServer.prototype.stop = function (cb) {
  var self = this;

  cb = cb || function () { return; };

  // TODO: save server mapping to disk!
  _.each(self.colab_servers, function (colab) {
    colab.poller.stop();
  });

  if (self.replicate_interval_id) {
    clearTimeout(self.replicate_interval_id);
  }

  if (self.rebalance_interval_id) {
    clearTimeout(self.rebalance_interval_id);
  }

  self.api_server.stop(cb);
};


exports.run = function () {
  var colabs,
    controller;

  log.set_log_level(settings.log_level);

  function shut_down(sig) {
    log.warn("Caught signal: %s. Stopping controller..", sig);
    controller.stop(function (err) {
      db.end();
      if (err) {
        log.error("Error stopping controller: %s", err);
        process.exit(1);
      }
      log.log("All done. Bye-bye!");
      process.exit(0);
    });
  }

  function start_up() {
    var auto = {};
    colabs = [];
    controller = new ColabControlServer();

    auto.cache_connect = function (cb) {
      if (settings.cache_servers) {
        return cache.connect(cb);
      }
      log.warn("No cache settings. Not connecting to cache.");
      return cb();
    };

    auto.colab_connect = function (cb) {
      async.each(colabs, function (colab, cb) {
        // TODO: retry on failure polling colab
        colab.poller.start(function (err) {
          if (err || !colab.id) {
            log.error("Error polling %s: %s", colab.toString(), err || "No colab id!");
            return cb();
          }
          if (controller.colab_servers[colab.id]) {
            return cb(util.format("Duplicate colab server with id %s", colab.id));
          }
          log.log("Adding colab %s", colab.id);
          controller.colab_servers[colab.id] = colab;
          return cb();
        });
      }, cb);
    };

    _.each(settings.colab_servers, function (colab_settings) {
      colabs.push(new colab.Colab(controller, colab_settings));
    });

    async.auto(auto, function (err) {
      if (err) {
        log.error(err);
        process.exit(1);
      }
      if (_.size(controller.colab_servers) === 0) {
        log.error("No colab servers up!");
        process.exit(1);
      }
      // Only enable backup behavior if we have a backup server configured.
      controller.backup = _.size(_.filter(controller.colab_servers, function (server) {
        return server.backup;
      }));
      log.log("Polling servers...");
      controller.start();
    });
  }

  process.on("SIGTERM", function () {shut_down("SIGTERM"); });
  process.on("SIGINT", function () {shut_down("SIGINT"); });

  process.on("SIGHUP", function (sig) {
    log.warn("Got SIGHUP", sig);
    controller.stop(function (err) {
      if (err) {
        log.error("Error stopping controller: %s", err);
        process.exit(1);
      }
      delete require.cache[require.resolve("./settings")];
      settings = require("./settings");
      start_up();
    });
  });

  start_up();
};
