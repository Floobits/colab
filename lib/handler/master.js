/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var tls = require("tls");
var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var actions = require("../actions");
var BaseAgentHandler = require("./base");
var ReplicationServerHandler = require("./replication_server");
var FlooProtocol = require("../protocol/floobits");
var settings = require("../settings");
var slave = require("../slave/slave");
var utils = require("../utils");


var MasterHandler = function () {
  var self = this;

  BaseAgentHandler.apply(this, arguments);

  self.proto_version = 0.11;
  self.server = null;
  self.perms = [
    "broadcast",
    "slave",
    "disconnect",
    "error",
    "load",
    "ping",
    "pong",
    "wallops",
    "workspaces",
    "workspace",
  ];
  self.stats_timeout = null;
};

util.inherits(MasterHandler, BaseAgentHandler);

MasterHandler.prototype.name = "my master";

MasterHandler.prototype.auth = function (server) {
  var self = this;

  self.server = server;
  self.db = server.db;
  utils.set_state(this, this.CONN_STATES.JOINED);
  clearTimeout(this.auth_timeout_id);

  self.request("slave", {
    action: "auth",
    username: settings.auth.username,
    password: settings.auth.password,
    colab_id: self.server.id,
    version: self.proto_version,
    backup: !!settings.backup,
    exclude: !!settings.exclude,
    colab_port: settings.json_port_ssl,
    api_port: settings.api_port,
  });

  this.send_stats();
};

MasterHandler.prototype.destroy = function () {
  MasterHandler.super_.prototype.destroy.call(this);
  this.server = null;
  this.stats_timeout = clearTimeout(this.stats_timeout);
};

MasterHandler.prototype.send_stats = function () {
  var self = this;

  async.parallel([
    self.send_workspaces.bind(self),
    self.send_load.bind(self),
  ], function (err) {
    if (err) {
      log.error(err);
    }
    self.stats_timeout = setTimeout(self.send_stats.bind(self), 10000);
  });
};

MasterHandler.prototype.send_workspaces = function (cb) {
  var self = this;

  slave.all_workspaces(self.server, function (err, workspaces) {
    if (err) {
      log.error("Error building workspace list!", err);
      return;
    }
    self.request("workspaces", { action: "set", workspaces: workspaces }, cb);
  });
};

MasterHandler.prototype.send_load = function (cb) {
  var self = this;

  slave.get_load(function (err, load) {
    if (err) {
      log.error("Error getting load info!", err);
      return;
    }
    self.request("load", { action: "set", data: load }, cb);
  });
};

MasterHandler.prototype.fetch_workspace = function (workspace_id, data, cb) {
  var self = this,
    conn_options = {
      host: data.ip,
      port: data.port,
    };

  log.log("Fetching %s from %s:%s", workspace_id, data.ip, data.port);

  let protocol = new FlooProtocol(++self.server.conn_number, data.is_ssl);
  try {
    let cleartext_stream = tls.connect(conn_options, function () {
      log.log("Connection established to %s:%s", data.ip, data.port);
      protocol.init_conn(cleartext_stream, true);
      protocol.install_handler(ReplicationServerHandler, self.server);
      protocol.handler.fetch(workspace_id, function (err, result) {
        cb(err, result);
        try {
          protocol.handler.disconnect();
        } catch (e) {
          log.error(e);
        }
      });
    });
    cleartext_stream.setEncoding("utf8");
    cleartext_stream.on("error", function (err) {
      log.error("Error on replication connection!", err);
      // TODO: reconnect or send error back
    });
  } catch (e) {
    log.warn(e);
    // TODO: reconnect or send error back
    cb(e);
    return;
  }
};

MasterHandler.prototype.on_workspace = function (req_id, data) {
  var self = this,
    cb,
    action = data.action,
    workspace_id = data.id;

  if (!workspace_id || !_.isFinite(workspace_id)) {
    self.error(req_id, "No workspace ID or bad ID");
    return;
  }

  if (!action) {
    self.error(req_id, util.format("No action for workspace %s.", workspace_id));
    return;
  }

  data = data.data;

  cb = function (err, result) {
    if (err) {
      self.error(req_id, err.toString(), false);
    } else {
      self.write("workspace", req_id, {
        action: action,
        data: result,
      });
    }
  };

  switch (action) {
  case "create":
    slave.create_workspace(self.server, workspace_id, data.version, cb);
    break;
  case "delete":
    slave.delete_workspace(self.server, workspace_id, data.username, cb);
    break;
  case "evict":
    slave.evict_workspace(self.server, workspace_id, data.reason, cb);
    break;
  case "fetch":
    self.fetch_workspace(workspace_id, data, cb);
    break;
  case "get":
    slave.get_workspace(self.server, workspace_id, data, cb);
    break;
  case "update":
    slave.update_workspace(self.server, workspace_id, data, cb);
    break;
  default:
    self.error(req_id, util.format("Unknown action for workspace %s.", workspace_id));
  }
};

MasterHandler.prototype.broadcast = function (action, data, cb) {
  this.request("broadcast", {
    action: action,
    data: data,
  }, cb);
};

MasterHandler.prototype.on_broadcast = function (req_id, data) {
  switch (data.type) {
  case "send_to_user":
    actions.broadcast.send_to_user(data.data);
    break;
  case "solicit":
    actions.broadcast.solicit(data.data);
    break;
  default:
    log.error("unsupported broadcast", data);
    this.error(req_id, "unsupported broadcast", false);
    return;
  }
  this.ack(req_id);
};

MasterHandler.prototype.on_disconnect = function (req_id, data) {
  log.error("disconnected from master because %s.", data.reason);
  this.ack(req_id);
  this.destroy();
};

MasterHandler.prototype.on_wallops = function (req_id, data) {
  var self = this;
  self.server.wallops(data.data);
  self.ack(req_id);
};

MasterHandler.prototype.on_motd = function (req_id, data) {
  this.server.motd = data.data;
  this.ack(req_id);
};

module.exports = MasterHandler;
