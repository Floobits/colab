var child_process = require("child_process");
var fs = require("fs");
var http = require("http");
var https = require("https");
var os = require("os");
var path = require("path");
var util = require("util");

var async = require("async");
var express = require("express");
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

var get_load = function (cb) {
  var l = {};
  l.memory = _.extend({
    freemem: os.freemem(),
    totalmem: TOTAL_MEM
  }, process.memoryUsage());

  l.memory = _.mapValues(l.memory, function (v) {
    return v / Math.pow(2, 20);
  });

  l.cpus = CPUS;
  l.loadavg = os.loadavg();

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

  get_load(function (err, l) {
    response = _.merge(response, l);
    if (err) {
      return res.json(500, err);
    }
    return res.json(response);
  });
};

var on_workspaces_all = function (server, req, res) {
  var rs,
    workspaces = {},
    response = { workspaces: workspaces };

  log.debug("%s asked for all workspaces", req.ip);

  rs = server.db.createReadStream({
    start: "version_",
    end: "version_999999999999999"
  });
  rs.on("close", function () {
    response.server_id = server.id;
    get_load(function (err, load) {
      if (err) {
        return res.json(500, err);
      }
      response.load = load;
      return res.json(response);
    });
  });
  rs.on("error", function (err) {
    log.error("Error reading db versions: %s", err);
    res.json(500, err.toString());
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

var on_workspace_get = function (server, req, res) {
  var auto = {},
    workspace_id = parseInt(req.params.workspace_id, 10),
    workspace = server.workspaces[workspace_id],
    workspace_json;

  if (workspace) {
    workspace_json = workspace.to_json();
    workspace_json.version = workspace.version;
    return res.send(workspace_json);
  }

  auto.version = function (cb) {
    server.db.get(util.format("version_%s", workspace_id), cb);
  };

  auto.rs = ["version", function (cb) {
    ldb.read_buf_info(null, workspace_id, cb);
  }];

  auto.bufs = ["rs", function (cb, response) {
    var bufs = {},
      rs = response.rs;

    cb = _.once(cb);

    rs.on("data", function (data) {
      bufs[data.value.id] = {
        path: data.value.path,
        id: data.value.id,
        md5: data.value.md5,
        encoding: parseInt(data.value.encoding, 10)
      };
    });
    rs.on("error", function (err) {
      return cb(err);
    });
    rs.on("close", function () {
      return cb(null, bufs);
    });
  }];

  async.auto(auto, function (err, result) {
    if (err) {
      if (err.type === "NotFoundError") {
        return res.send(404);
      }
      if (err.type === "OpenError") {
        // TODO: delete from server db?
        log.error("%s exists in server DB but not filesystem", workspace_id);
      }
      return res.send(500, err.toString());
    }
    return res.json({
      bufs: result.bufs,
      version: parseInt(result.version, 10)
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
    if (!err) {
      return res.send(result);
    }
    if (err.type !== "NotFoundError") {
      return res.send(500, err.toString());
    }
    ldb.get(null, workspace_id, util.format("buf_%s", buf_id), "json", function (err) {
      if (!err) {
        // Empty buffer
        return res.send(new Buffer(0));
      }
      if (err.type === "NotFoundError") {
        return res.send(404);
      }
      return res.send(500, err.toString());
    });
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
