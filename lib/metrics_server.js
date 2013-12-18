var child_process = require("child_process");
var fs = require("fs");
var http = require("http");
var https = require("https");
var os = require("os");
var path = require("path");
var util = require("util");

var async = require("async");
var express = require("express");
var levelup = require("levelup");
var log = require("floorine");
var _ = require("lodash");

var settings = require("./settings");


var CPUS = _.size(os.cpus());
var TOTAL_MEM = os.totalmem();

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

  if (req.params && req.params.metric) {
    type = req.params.metric;
  } else {
    type = req.url.split("/")[1];
  }

  if (type === undefined || (_.indexOf(["version", "platform", "client"], type) < 0)) {
    // This should never happen
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

var on_workspaces_active = function (server, req, res) {
  var response = {};

  log.debug("%s asked for active workspaces", req.ip);

  response.workspaces = _.map(server.workspaces, function (workspace) {
    return {
      id: workspace.id,
      name: workspace.name,
      owner: workspace.owner,
      version: workspace.version
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

var on_workspaces_all = function (server, req, res) {
  var response = {};

  log.debug("%s asked for all workspaces", req.ip);

  fs.readdir(settings.buf_storage.local.dir, function (err, files) {
    if (err) {
      res.send(500, err.toString());
      return;
    }
    async.eachLimit(files, 10, function (file, cb) {
      var db_path = path.join(settings.buf_storage.local.dir, file, "db"),
        workspace,
        workspace_id = parseInt(file, 10);
      if (!_.isFinite(workspace_id)) {
        setImmediate(cb);
        return;
      }
      workspace = server.workspaces[file];
      if (server.workspaces[file]) {
        response[file] = {
          active: true,
          id: workspace.id,
          name: workspace.name,
          owner: workspace.owner,
          version: workspace.version
        };
        setImmediate(cb);
        return;
      }
      if (workspace_id % 250) {
        log.debug("reading %s", db_path);
      }
      levelup(db_path, { valueEncoding: "json" }, function (err, result) {
        var ldb = result;
        if (err) {
          return cb(err);
        }
        ldb.get("version", function (err, result) {
          if (err && err.type !== "NotFoundError") {
            ldb.close();
            cb(err);
            return;
          }
          response[file] = {
            active: false,
            id: workspace_id,
            version: result
          };
          ldb.close();
          cb();
        });
      });
    }, function (err) {
      if (err) {
        res.send(500, err.toString());
        return;
      }
      res.send(JSON.stringify(response));
    });
  });
};

// TODO: expose room info (buf ids & md5s) & bufs over http

var listen = function (port, server) {
  var app = express(),
    s;

  app.use(express.bodyParser());
  app.use(express.logger());

  // Old URLs
  app.get("/client", on_metrics.bind(app, server));
  app.get("/platform", on_metrics.bind(app, server));
  app.get("/version", on_metrics.bind(app, server));
  app.get("/control_stats", on_workspaces_active.bind(app, server));

  // New URLs
  app.get("/workspaces/active", on_workspaces_active.bind(app, server));
  app.get("/workspaces/all", on_workspaces_all.bind(app, server));
  app.get("/metric/:metric", on_metrics.bind(app, server));

  s = http.createServer(app);
  s.listen(port);
};

module.exports = {
  listen: listen
};
