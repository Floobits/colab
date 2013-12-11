var child_process = require("child_process");
var http = require("http");
var https = require("https");
var os = require("os");
var util = require("util");

var express = require("express");
var log = require("floorine");
var _ = require("lodash");

var settings = require("./settings");


var CPUS = _.size(os.cpus());
var TOTAL_MEM = os.totalmem();


var on_control_stats = function (server, req, res) {
  var response = {};

  response.workspaces = _.map(server.workspaces, function (workspace) {
    return {
      id: workspace.id,
      name: workspace.name,
      owner: workspace.owner
    };
  });

  response.memory = _.extend({
    freemem: os.freemem(),
    totalmem: TOTAL_MEM
  }, process.memoryUsage());

  response.cpus = CPUS;
  response.loadavg = os.loadavg();

  // ggreer@carbon:~% df -k -P /
  // Filesystem 1024-blocks      Used Available Capacity  Mounted on
  // /dev/disk1   243950084 124733168 118960916    52%    /
  child_process.exec(util.format("df -P -m %s", settings.buf_storage.local.dir), function (err, stdout) {
    var lines;
    if (err) {
      log.error(err);
      res.end(JSON.stringify(response));
      return;
    }

    response.disk = {};
    // Kill first and last lines in output
    lines = stdout.split("\n").slice(1, -1);

    _.each(lines, function (disk) {
      disk = disk.replace(/[\s\n\r]+/g, " ").split(" ");
      response.disk[disk[5]] = {
        total: disk[1],
        used: disk[2],
        available: disk[3]
      };
    });

    res.end(JSON.stringify(response));
  });
};

var on_metrics = function (server, req, res) {
  var metrics = {},
    status = "ok",
    message = "harro",
    type,
    reply;

  reply = function () {
    res.writeHead(200);
    var data = util.format("status %s %s\n", status, message);
    _.each(metrics, function (v, k) {
      data += util.format("metric %s int %s\n", k, v);
    });
    res.end(data);
  };

  type = req.url.split("/")[1];
  if (type === undefined || (_.indexOf(["version", "platform", "client"], type) < 0)) {
    log.warn("Tried to fetch: " + type);
    status = "error";
    message = "404";
    return reply();
  }

  _.each(server.agents, function (agent) {
    var metric = (agent[type] && agent[type].toString()) || "undefined";
    metric = metric.replace(/\s/g, "");

    if (!metrics[metric]) {
      metrics[metric] = 1;
    } else {
      metrics[metric] += 1;
    }
  });

  return reply();
};

var listen = function (port, server) {
  var app = express(),
    s;

  app.use(express.bodyParser());
  app.get("/client", on_metrics.bind(app, server));
  app.get("/platform", on_metrics.bind(app, server));
  app.get("/version", on_metrics.bind(app, server));

  app.get("/control_stats", on_control_stats.bind(app, server));

  s = http.createServer(app);
  s.listen(port);
};

module.exports = {
  listen: listen
};
