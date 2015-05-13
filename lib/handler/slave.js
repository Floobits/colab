"use strict";

const util = require("util");

const _ = require("lodash");
const log = require("floorine");

const actions = require("../actions");
const BaseAgentHandler = require("./base");
const settings = require("../settings");
const utils = require("../utils");

const AUTHED_PERMS = [
  "ack",
  "broadcast",
  "disconnect",
  "error",
  "load",
  "motd",
  "ping",
  "pong",
  "workspace",
  "workspaces",
];

const SlaveHandler = function () {
  var self = this;

  BaseAgentHandler.apply(self, arguments);

  // Initial perms. They'll get more if they auth.
  self.perms = ["slave"];

  // Exclude is set to its real value on workspaces
  self.exclude = true;
  self.backup = null;
  // TODO: actually set this based on whether we're using SSL
  self.ssl = true;

  // Time at which we were last disconnected
  self.disconnected = 0;
  self.id = "";
  self.colab_port = null;
  self.ip = "";
  self.load = {
    memory: {},
    loadavg: null,
    cpus: null,
    disk: {},
    uptime: {}
  };

  self.workspaces = {};
  self.active_workspaces = {};

  self.heartbeat_idle_period = 5000;
  self.disconnect_timeout = 15000;
};

util.inherits(SlaveHandler, BaseAgentHandler);

SlaveHandler.prototype.name = "slave";
SlaveHandler.prototype.is_slave = true;

SlaveHandler.prototype.to_json = function () {
  var self = this;
  return {
    id: self.id,
    ip: self.ip,
    colab_port: self.colab_port,
    backup: self.backup,
    exclude: self.exclude,
    load: self.load,
    active_workspaces: self.active_workspaces,
  };
};

SlaveHandler.prototype.conn_info = function () {
  return {
    api_port: this.api_port,
    ip: this.ip,
    ip_proto: this.ip_proto,
    port: this.colab_port,
    ssl: this.ssl,
  };
};

SlaveHandler.prototype.toString = function () {
  return this.id;
};

SlaveHandler.prototype.on_slave = function (req_id, data) {
  var self = this,
    colab_id = data.colab_id;

  if (data.action !== "auth") {
    self.disconnect("Invalid action.");
    return;
  }

  clearTimeout(self.auth_timeout_id);

  if (!colab_id) {
    self.disconnect("No colab id in auth!");
    return;
  }

  if (!data.colab_port || !data.api_port) {
    self.disconnect("Missing port info!");
    return;
  }

  if (data.username !== settings.auth.username || data.password !== settings.auth.password) {
    self.disconnect("Invalid auth.");
    return;
  }

  self.ip = self.protocol.remote_address;
  self.ip_proto = self.protocol.remote_family;
  self.perms = AUTHED_PERMS;
  self.id = colab_id;
  self.colab_port = data.colab_port;
  self.api_port = data.api_port;
  self._exclude = !!data.exclude;
  self.backup = !!data.backup;
  // Exclude backup servers from repcounts and whatnot.
  if (self.backup) {
    self.exclude = true;
  }
  self.error_count = 0;
  // Limited to 20 most recent errors
  self.error_list = [];

  utils.set_state(self, self.CONN_STATES.JOINED);

  actions.slave.add(self.id, self);
  self.ack(req_id);
  self.on_pong();
};

SlaveHandler.prototype.on_workspaces = function (req_id, data) {
  var self = this;

  switch (data.action) {
  case "set":
    self.exclude = self._exclude;
    if (!_.isEmpty(self.workspaces)) {
      _.each(data.workspaces, function (w, id) {
        var server_w = self.workspaces[id];
        if (!_.isEqual(server_w, w)) {
          let err_msg = util.format("workspace %s mismatch!\n%s\n!=%s\n", id, JSON.stringify(server_w, null, 2), JSON.stringify(w, null, 2));
          log.error(err_msg);
          self.error_list.push(err_msg);
          self.error_list = self.error_list.slice(-1 * settings.max_events);
          self.error_count++;
        }
      });
    }
    self.workspaces = data.workspaces;
    self.active_workspaces = {};
    _.each(self.workspaces, function (w, id) {
      if (w.active) {
        self.active_workspaces[id] = w;
      }
    });
    actions.slave.update_counts(self.id, self.workspaces);
  break;
  default:
    self.error(req_id, "Invalid action");
    return;
  }

  if (req_id) {
    self.ack(req_id);
  }
};

SlaveHandler.prototype.on_load = function (req_id, data) {
  var self = this;

  self.load = data.data;
  return self.ack(req_id);
};

SlaveHandler.prototype.workspace = function (id, action, data, cb) {
  var self = this;
  self.request("workspace", {
    id: id,
    action: action,
    data: data,
  }, function (err, result) {
    if (result && result.data) {
      result = result.data;
    }
    return cb(err, result);
  });
};

SlaveHandler.prototype.on_workspace = function (req_id, data) {
  var self = this,
    workspace = data.data;

  if (!_.isObject(workspace)) {
    self.error(req_id, "Invalid workspace.");
    return;
  }

  switch (data.action) {
  case "create":
    if (self.workspaces[workspace.id]) {
      log.warn("%s created workspace %s which already exists!", self.toString(), workspace.id);
    }
    self.workspaces[workspace.id] = workspace;
    if (workspace.active) {
      self.active_workspaces[workspace.id] = workspace;
    }
    actions.slave.create_workspace(self.id, workspace);
    break;
  case "delete":
    if (!self.workspaces[workspace.id]) {
      log.warn("Deleting workspace %s which doesn't exist!", workspace.id);
    }
    actions.slave.delete_workspace(self.id, workspace);
    delete self.workspaces[workspace.id];
    delete self.active_workspaces[workspace.id];
    break;
  case "evict":
    self.workspaces[workspace.id].active = false;
    delete self.active_workspaces[workspace.id];
    actions.slave.evict_workspace(self.id, workspace);
    break;
  case "get":
    break;
  case "fetch":
  case "update":
    if (!self.workspaces[workspace.id]) {
      log.warn("%s updating workspace %s which doesn't exist!", workspace.id);
    }
    // TODO: validate object before stomping?
    self.workspaces[workspace.id] = workspace;
    if (workspace.active) {
      self.active_workspaces[workspace.id] = workspace;
    } else {
      delete self.active_workspaces[workspace.id];
    }
    actions.slave.update_workspace(self.id, workspace);
    break;
  default:
    self.error(req_id, "Invalid action");
    return;
  }


  if (req_id) {
    self.ack(req_id);
  }
};

SlaveHandler.prototype.broadcast = function (data, cb) {
  var self = this;
  self.request("broadcast", data, cb);
};

SlaveHandler.prototype.on_broadcast = function (req_id, data) {
  var self = this;

  // TODO: for pro stuff, make sure there's a pro workspace around on at least one slave, otherwise, error out

  actions.broadcast.send_to_slaves(self, data, function (err) {
    if (err) {
      // TODO? something else here?
      self.error(req_id, err);
      return;
    }
    self.ack(req_id);
  });
};

SlaveHandler.prototype.on_error = function (req_id) {
  this.ack(req_id);
};

SlaveHandler.prototype.wallops = function (wallops, cb) {
  var self = this;
  self.request("wallops", {data: wallops}, cb);
};

SlaveHandler.prototype.motd = function (motd, cb) {
  var self = this;
  self.request("motd", {data: motd}, cb);
};

module.exports = SlaveHandler;
