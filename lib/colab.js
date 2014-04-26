/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var log = require("floorine");
var _ = require("lodash");

var cache = require("./cache");
var poll = require("./poll");
var settings = require("./settings");

var settings_keys = ["ip", "external_ip", "api_port", "colab_port", "ssl", "name", "exclude", "backup"];


var Colab = function (controller, server_settings) {
  var self = this;

  _.each(settings_keys, function (key) {
    if (server_settings[key]) {
      self[key] = server_settings[key];
    }
  });

  // Exclude backup servers from repcounts and whatnot.
  if (self.backup) {
    self.exclude = true;
  }

  self.id = null;
  self.load = {
    memory: {},
    loadavg: null,
    cpus: null,
    disk: {},
    uptime: {}
  };

  self.controller = controller;
  self.poller = new poll.ColabPoller(self);
  self.active_workspaces = [];
};

Colab.prototype.toString = function () {
  var self = this;
  return util.format("%s %s://%s:%s", (self.name || ""), (self.ssl ? "https" : "http"), self.ip, self.api_port);
};

/*jslint unparam: true */
Colab.prototype.to_json = function () {
  var self = this;
  return _.omit(self, function (v, k) {
    return _.contains(["controller", "poller", "workspaces"], k);
  });
};
/*jslint unparam: false */

Colab.prototype.update_memcached = function () {
  var self = this,
    workspaces = self.controller.workspaces,
    active_workspaces = [];

  _.each(self.controller.server_mapping.workspace, function (server, workspace_id) {
    // Awesome
    var workspace = workspaces[workspace_id].colabs[server.id];
    if (workspace.users) {
      cache.set(util.format("active_users_%s", workspace_id), workspace.users, {flags: 0, exptime: 30});
    } else {
      cache.del(util.format("active_users_%s", workspace_id));
    }
    active_workspaces.push({
      server: server.name,
      id: parseInt(workspace_id, 10),
      users: workspace.users
    });
  });

  self.active_workspaces = active_workspaces;
  cache.set("active_workspaces", active_workspaces, function (err) {
    if (err) {
      log.error("Error setting active_workspaces in memcached:", err);
    } else {
      log.debug("Set active_workspaces to", active_workspaces);
    }
  });
};

Colab.prototype.update_workspace_counts = function (body) {
  var self = this,
    controller = self.controller;

  // Filter out current server from workspace info. Probably a better way to do this.
  _.each(controller.workspaces, function (w) {
    delete w.colabs[self.id];
  });

  _.each(body.workspaces, function (workspace) {
    var old_server,
      w;

    if (workspace.owner && workspace.name) {
      // active workspace
      old_server = controller.server_mapping.workspace[workspace.id];
      if (old_server && (old_server.ip !== self.ip || old_server.colab_port !== self.colab_port)) {
        // This should never happen
        log.error("OH NO! Workspace moved from %s:%s to %s:%s", old_server.ip, old_server.colab_port, self.ip, self.colab_port);
        controller.moved_workspaces.push({
          workspace: workspace,
          from: old_server.to_json(),
          to: self.to_json()
        });
      }
      controller.set_mapping(workspace.id, self);
    }

    w = controller.workspaces[workspace.id];
    if (!w) {
      w = {
        id: workspace.id,
        colabs: {}
      };
      controller.workspaces[workspace.id] = w;
    }
    w.colabs[self.id] = {
      version: workspace.version,
      active: workspace.active
    };
    if (workspace.users) {
      w.colabs[self.id].users = workspace.users;
    }
  });

  if (body.load) {
    self.load = body.load;
    if (self.load.disk) {
      self.load.disk.usage = self.load.disk.used / self.load.disk.total;
    }
  }
  self.update_memcached();
};


module.exports = {
  Colab: Colab
};
