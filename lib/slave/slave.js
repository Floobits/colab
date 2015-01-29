/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var child_process = require("child_process");
var http = require("http");
var https = require("https");
var os = require("os");
var path = require("path");
var util = require("util");

var _ = require("lodash");
var async = require("async");
var fs = require("fs-extra");
var log = require("floorine");

var ldb = require("../ldb");
var RoomEvent = require("../room_event");
var settings = require("../settings");
var utils = require("../utils");

var CPUS = _.size(os.cpus());
var TOTAL_MEM = os.totalmem();


var get_load = function (cb) {
  var l = {};
  l.memory = _.extend({
    memFree: os.freemem(),
    memTotal: TOTAL_MEM,
    memUsed: TOTAL_MEM - os.freemem()
  }, process.memoryUsage());

  l.memory = _.mapValues(l.memory, function (v) {
    return v / Math.pow(2, 20);
  });

  l.cpus = CPUS;
  l.loadavg = os.loadavg();
  l.uptime = {
    process: process.uptime(),
    system: os.uptime()
  };

  // ggreer@carbon:~% df -k -P /
  // Filesystem 1024-blocks      Used Available Capacity  Mounted on
  // /dev/disk1   243950084 124733168 118960916    52%    /
  child_process.exec(util.format("df -P -m %s", settings.base_dir), function (err, stdout) {
    var lines;
    if (err) {
      return cb(err, l);
    }

    l.disk = {
      total: 0,
      used: 0,
      available: 0
    };
    // Kill first and last lines in output
    lines = stdout.split("\n").slice(1, -1);

    // Don't expose partitions. Just answer how much free space we have
    _.each(lines, function (disk) {
      disk = disk.replace(/[\s\n\r]+/g, " ").split(" ");
      l.disk.total += parseInt(disk[1], 10) / Math.pow(2, 10);
      l.disk.used += parseInt(disk[2], 10) / Math.pow(2, 10);
      l.disk.available += parseInt(disk[3], 10) / Math.pow(2, 10);
    });
    l.disk.usage = l.disk.used / l.disk.total;
    return cb(err, l);
  });
};

var all_workspaces = function (server, cb) {
  var rs,
    workspaces = {};

  rs = server.db.createReadStream({
    start: "version_",
    end: "version_999999999999999"
  });
  rs.on("close", function () {
    cb(null, workspaces);
  });
  rs.on("error", function (err) {
    log.error("Error reading db versions: %s", err);
    cb(err, workspaces);
  });
  rs.on("data", function (data) {
    var workspace,
      workspace_id = parseInt(data.key.slice(8), 10);

    if (!_.isFinite(workspace_id)) {
      log.error("Can't parse key %s", data.key);
      return;
    }

    workspace = server.workspaces[workspace_id];
    if (workspace) {
      workspaces[workspace_id] = {
        active: true,
        id: workspace.id,
        name: workspace.name,
        owner: workspace.owner,
        users: _.map(workspace.handlers, function (agent) {
          return {
            client: agent.client,
            user_id: agent.user_id,
            is_anon: agent.is_anon,
            platform: agent.platform,
            username: agent.username,
            version: agent.version
          };
        }),
        version: workspace.version
      };
      return;
    }
    workspaces[workspace_id] = {
      active: false,
      id: workspace_id,
      version: parseInt(data.value, 10)
    };
  });
};

module.exports = {
  get_load: get_load,
  all_workspaces: all_workspaces,
};
