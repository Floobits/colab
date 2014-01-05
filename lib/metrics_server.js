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

var ldb = require("./ldb");
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
  child_process.exec(util.format("df -P -m %s", settings.base_dir), function (err, stdout) {
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
  var response = {
    workspaces: {}
  };

  log.debug("%s asked for all workspaces", req.ip);

  fs.readdir(settings.bufs_dir, function (err, files) {
    if (err) {
      res.send(500, err.toString());
      return;
    }
    async.eachLimit(files, 10, function (file, cb) {
      var workspace,
        workspace_id = parseInt(file, 10);
      if (!_.isFinite(workspace_id)) {
        setImmediate(cb);
        return;
      }
      workspace = server.workspaces[file];
      if (server.workspaces[file]) {
        response.workspaces[file] = {
          active: true,
          id: workspace.id,
          name: workspace.name,
          owner: workspace.owner,
          version: workspace.version
        };
        setImmediate(cb);
        return;
      }
      server.db.get(util.format("version_%s", file), function (err, result) {
        if (err && err.type !== "NotFoundError") {
          cb(err);
          return;
        }
        result = parseInt(result, 10);
        response.workspaces[file] = {
          active: false,
          id: workspace_id,
          version: result
        };
        cb();
      });
    }, function (err) {
      if (err) {
        res.send(500, err.toString());
        return;
      }
      response.server_id = server.id;
      res.send(JSON.stringify(response));
    });
  });
};

var on_workspace_get = function (server, req, res) {
  var workspace_id = parseInt(req.params.workspace_id, 10),
    workspace = server.workspaces[workspace_id],
    workspace_json;

  if (workspace) {
    workspace_json = workspace.to_json();
    workspace_json.version = workspace.version;
    return res.send(workspace_json);
  }

  workspace = {
    bufs: {}
  };

  server.db.get(util.format("version_%s", workspace_id), function (err, result) {
    if (err) {
      if (err.type === "NotFoundError") {
        return res.send(404);
      }
      return res.send(500, err);
    }
    workspace.version = parseInt(result, 10);

    ldb.read_buf_info(null, workspace_id, function (err, rs) {
      if (err) {
        if (err.type === "OpenError") {
          return res.send(404);
        }
        return res.send(500, err.toString());
      }
      rs.on("data", function (data) {
        workspace.bufs[data.value.id] = {
          path: data.value.path,
          id: data.value.id,
          md5: data.value.md5,
          encoding: parseInt(data.value.encoding, 10)
        };
      });
      rs.on("error", function (err) {
        return res.send(500, err);
      });
      rs.on("close", function () {
        return res.send(workspace);
      });
    });
  });
};

var on_buf_get = function (server, req, res) {
  var buf,
    buf_id = parseInt(req.params.buf_id, 10),
    workspace_id = parseInt(req.params.workspace_id, 10),
    workspace = server.workspaces[workspace_id];

  // TODO: check etag. send content md5sum header and possibly mime type based on buf encoding
  if (workspace) {
    buf = workspace.bufs[buf_id];
    if (!buf) {
      return res.send(404);
    }
    return res.send(buf._state);
  }
  ldb.get(null, workspace_id, util.format("buf_content_%s", buf_id), "binary", function (err, result) {
    if (err) {
      if (err.type === "NotFoundError") {
        return res.send(404);
      }
      return res.send(500, err.toString());
    }
    return res.send(result);
  });
};


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
  app.get("/workspace/:workspace_id/:buf_id", on_buf_get.bind(app, server));
  app.get("/workspace/:workspace_id", on_workspace_get.bind(app, server));
  app.get("/metric/:metric", on_metrics.bind(app, server));

  s = http.createServer(app);
  s.listen(port);
};

module.exports = {
  listen: listen
};
