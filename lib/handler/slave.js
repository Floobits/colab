/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var BaseAgentHandler = require("./base");
var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var settings = require("../settings");
var utils = require("../utils");
var actions = require("../actions");

var SlaveHandler = function () {
  var self = this;

  BaseAgentHandler.apply(self, arguments);

  // Initial perms. They'll get more if they auth.
  self.perms = ["colab_auth"];
  self.exclude = null;
  self.backup = null;
  self.id = null;
  self.load = {
    memory: {},
    loadavg: null,
    cpus: null,
    disk: {},
    uptime: {}
  };

  self.active_workspaces = [];

  self.heartbeat_idle_period = 5000;
  self.disconnect_timeout = 15000;
};

util.inherits(SlaveHandler, BaseAgentHandler);

SlaveHandler.prototype.name = "slave";

SlaveHandler.prototype.on_colab_auth = function (req_id, data) {
  var self = this,
    colab_id = data.colab_id;

  clearTimeout(self.auth_timeout_id);

  if (!colab_id) {
    self.disconnect("No colab id in auth!");
    return;
  }

  if (data.username !== settings.auth.username || data.password !== settings.auth.password) {
    self.disconnect("Invalid auth.");
    return;
  }

  self.perms = ["ping", "pong", "disconnect", "workspaces", "load"];
  self.id = colab_id;
  self.exclude = !!data.exclude;
  self.backup = !!data.backup;
  // Exclude backup servers from repcounts and whatnot.
  if (self.backup) {
    self.exclude = true;
  }

  utils.set_state(self, self.CONN_STATES.JOINED);

  actions.slave.add(self.id, self);
  self.ack(req_id);
  self.on_pong();
};

SlaveHandler.prototype.on_workspaces = function (req_id, data) {
  var self = this;

  actions.slave.update_counts(self.id, data.workspaces);
  return self.ack(req_id);
};

SlaveHandler.prototype.on_load = function (req_id, data) {
  var self = this;

  actions.slave.update_load(data.load);
  return self.ack(req_id);
};

SlaveHandler.prototype.is_master = true;

SlaveHandler.prototype.to_json = function () {
  var self = this;
  return _.omit(self, function (v, k) {
    return _.contains(["controller", "poller", "workspaces"], k);
  });
};


// // TODO: move to master.js
// Colab.prototype.update_memcached = function () {
//   var self = this,
//     workspaces = self.controller.workspaces,
//     active_workspaces = [],
//     self_active_workspaces = [];

//   _.each(self.controller.server_mapping.workspace, function (server, workspace_id) {
//     var d,
//       workspace;
//     // Awesome
//     // TODO: figure out WTF is actually breaking here
//     try {
//       workspace = workspaces[workspace_id].colabs[server.id];
//       d = {
//         server: server.name,
//         id: parseInt(workspace_id, 10),
//         users: workspace.users
//       };
//       active_workspaces.push(d);
//       if (server.id === self.id) {
//         self_active_workspaces.push(d);
//       }
//       if (workspace.users) {
//         cache.set(util.format("active_users_%s", workspace_id), workspace.users, {flags: 0, exptime: 30});
//       } else {
//         cache.del(util.format("active_users_%s", workspace_id));
//       }
//     } catch (e) {
//       log.error("Error updating cache for %s: %s", workspace_id, e);
//     }
//   });

//   self.active_workspaces = self_active_workspaces;
//   cache.set("active_workspaces", active_workspaces, function (err) {
//     if (err) {
//       log.error("Error setting active_workspaces in memcached:", err);
//     } else {
//       log.debug("Set active_workspaces to", active_workspaces);
//     }
//   });
// };


// // TODO: move to master.js
// Colab.prototype.update_workspace_counts = function (body) {
//   var self = this,
//     controller = self.controller;

//   // Filter out current server from workspace info. Probably a better way to do this.
//   _.each(controller.workspaces, function (w) {
//     delete w.colabs[self.id];
//   });

//   _.each(body.workspaces, function (workspace) {
//     var old_server,
//       w;

//     if (workspace.owner && workspace.name) {
//       // active workspace
//       old_server = controller.server_mapping.workspace[workspace.id];
//       if (old_server && (old_server.ip !== self.ip || old_server.colab_port !== self.colab_port)) {
//         // This should never happen
//         log.error("OH NO! Workspace moved from %s:%s to %s:%s", old_server.ip, old_server.colab_port, self.ip, self.colab_port);
//         controller.moved_workspaces.push({
//           workspace: workspace,
//           from: old_server.to_json(),
//           to: self.to_json()
//         });
//       }
//       controller.set_mapping(workspace.id, self);
//     }

//     w = controller.workspaces[workspace.id];
//     if (!w) {
//       w = {
//         id: workspace.id,
//         colabs: {}
//       };
//       controller.workspaces[workspace.id] = w;
//     }
//     w.colabs[self.id] = {
//       version: workspace.version,
//       active: workspace.active
//     };
//     if (workspace.users) {
//       w.colabs[self.id].users = workspace.users;
//     }
//   });

//   if (body.load) {
//     self.load = body.load;
//     if (self.load.disk) {
//       self.load.disk.usage = self.load.disk.used / self.load.disk.total;
//     }
//   }
//   self.update_memcached();
// };


module.exports = SlaveHandler;
