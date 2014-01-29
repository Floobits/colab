var child_process = require("child_process");
var http = require("http");
var https = require("https");
var os = require("os");
var path = require("path");
var util = require("util");
var utils = require("./utils");

var _ = require("lodash");
var async = require("async");
var express = require("express");
var fs = require("fs-extra");
var log = require("floorine");
var request = require("request");

var db = require("./db");
var ldb = require("./ldb");
var settings = require("./settings");

var CPUS = _.size(os.cpus());
var TOTAL_MEM = os.totalmem();
request = request.defaults({
  sendImmediately: true,
  strictSSL: false
});


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

var verify_workspace = function (server, req, res) {
  var auto = {},
    workspace_id = parseInt(req.params.workspace_id, 10);

  auto.server_db = function (cb) {
    server.db.get(util.format("version_%s", workspace_id), cb);
  };

  auto.db = ["server_db", function (cb) {
    ldb.get_db(null, workspace_id, null, cb);
  }];

  auto.verify_bufs = ["db", function (cb, res) {
    var db = res.db,
      brs,
      errs = [];

    brs = db.createReadStream({
      start: "buf_",
      end: "buf_999999999999",
      valueEncoding: "json"
    });

    brs.on("data", function (data) {
      var buf_id = parseInt(data.key.slice(4), 10),
        expected_md5 = data.value.md5;
      db.get(util.format("buf_content_%s", buf_id), { valueEncoding: "binary" }, function (err, result) {
        if (err) {
          if (err.type === "NotFoundError") {
            err = null;
            result = new Buffer(0);
          }
        }
        var md5 = utils.md5(result);
        if (expected_md5 !== md5) {
          if (md5 === "d41d8cd98f00b204e9800998ecf8427e") {
            err = util.format("Buf %s/%s is empty!", workspace_id, buf_id);
          } else {
            err = util.format("Buf %s/%s md5 mismatch! Expected %s. Got %s", workspace_id, buf_id, expected_md5, md5);
            if (utils.md5(result.toString()) === expected_md5) {
              err += util.format("Encoding issue!");
            }
          }
        }
        errs.push(err);
      });
    });
    brs.on("close", function (err) {
      if (errs.length === 0) {
        errs = null;
      }
      return cb(err || errs);
    });
  }];

  async.auto(auto, function (err, result) {
    if (result.db) {
      ldb.finish_db(result.db, workspace_id);
    }
    if (err) {
      if (err.type === "NotFoundError") {
        return res.send(404);
      }
      return res.send(500, err);
    }
    return res.send(204);
  });
};


var load_workspace = function (server, name, owner, id, load) {
  var workspace = _.where(server.workspaces, {
    name: name,
    owner: owner
  });

  if (workspace.length === 0 || !workspace[0].evict) {
    if (!load) {
      return;
    }
    if (!id) {
      // TODO: load workspace from disk based on name & owner?
      log.error("No id for %s (%s/%s) Implement me!", name, owner);
      return;
    }
    log.error("Couldn't load %s (%s/%s) Implement me!", id, name, owner);
    return;
  }
  return workspace[0];
};

var delete_workspace_by_id = function (server, req, res) {
  var auto = {},
    workspace_id = parseInt(req.params.workspace_id, 10),
    db = ldb.open_dbs[workspace_id],
    reason = "This workspace was deleted.",
    workspace = server.workspaces[workspace_id],
    workspace_path = path.normalize(path.join(settings.bufs_dir, util.format("%s", workspace_id)));

  if (workspace_path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Bufs dir: %s", workspace_path, settings.bufs_dir);
    return res.send(500, "Error code 93897.");
  }

  if (workspace) {
    if (req.body && req.body.username) {
      reason = util.format("%s deleted this workspace.", req.body.username);
    }
    workspace.evict(reason);
  }

  if (db) {
    if (db.refcount > 0) {
      return res.send(400, "Workspace is in use.");
    }
    auto.close_db = ["exists", function (cb) {
      ldb.close_db(db, workspace_id, cb);
    }];
  }

  auto.exists = function (cb) {
    fs.exists(workspace_path, function (exists) {
      return cb(null, exists);
    });
  };

  auto.del_db = ["exists"];
  if (auto.close_db) {
    auto.del_db.push("close_db");
  }
  auto.del_db.push(function (cb) {
    server.db.del(util.format("version_%s", workspace_id), cb);
  });

  auto.rm = ["del_db", function (cb) {
    log.debug("removing %s", workspace_path);
    fs.remove(workspace_path, cb);
  }];

  async.auto(auto, function (err, result) {
    if (err) {
      if (err.type === "NotFoundError") {
        return res.send(404, err);
      }
      return res.send(500, err);
    }
    if (!result.exists) {
      return res.send(404);
    }
    return res.send(204);
  });
};

var evict_workspace = function (server, req, res, reason) {
  var workspace = load_workspace(server, req.params.workspace, req.params.owner);

  if (!workspace) {
    return res.send(404);
  }
  workspace.evict(reason || req.body.reason);
  return res.send(204);
};

var evict_workspace_by_id = function (server, req, res, reason) {
  var workspace_id = parseInt(req.params.workspace_id, 10),
    workspace = server.workspaces[workspace_id];

  if (!workspace) {
    // Nobody in the workspace to evict
    return res.send(400);
  }
  workspace.evict(reason || req.body.reason);
  return res.send(204);
};

var set_workspace_version = function (server, req, res) {
  var workspace = load_workspace(server, req.params.workspace, req.params.owner);

  if (!workspace) {
    return res.send(404);
  }

  workspace.version = req.body.version;
  workspace.save(function (err) {
    if (err) {
      return res.send(500, err);
    }
    return res.send(204);
  });
};

var set_workspace_version_by_id = function (server, req, res) {
  var workspace_id = parseInt(req.params.workspace_id, 10),
    workspace = server.workspaces[workspace_id];

  if (!workspace) {
    // TODO: fetch workspace off disk
    return res.send(400);
  }

  workspace.version = req.body.version;
  workspace.save(function (err) {
    if (err) {
      return res.send(500, err);
    }
    return res.send(204);
  });
};

// Fetch a workspace from another server
var fetch_workspace = function (server, req, res) {
  var auto = {},
    ip = req.body.ip,
    port = req.body.port,
    proto = req.body.proto || "http",
    workspace_id = req.params.workspace_id;

  // TODO: validate req.body

  if (server.workspaces[workspace_id]) {
    // TODO: make it ok to fetch active workspaces?
    return res.send(400, util.format("Workspace %s is active!", workspace_id));
  }

  auto.get_buf_list = function (cb) {
    var options = {
        json: true
      },
      url = util.format("%s://%s:%s/workspace/%s", proto, ip, port, workspace_id);

    log.debug("Hitting %s", url);
    request.get(url, options, function (err, response, body) {
      if (err) {
        return cb(err, response);
      }
      if (response.statusCode >= 400) {
        return cb(util.format("Code %s from %s", response.statusCode, url));
      }
      return cb(err, body);
    });
  };

  auto.mkdirp = function (cb) {
    fs.mkdirs(ldb.get_db_path(workspace_id), cb);
  };

  auto.local_readstream = ["mkdirp", function (cb) {
    ldb.read_buf_info(null, workspace_id, function (err, rs) {
      if (err) {
        if (err.type === "OpenError" && err.message.indexOf("does not exist") > 0) {
          // Squelch "DB doesn't exist" error
          err = null;
        } else {
          log.warn("Error reading local db %s: %s", workspace_id, err);
        }
      }
      return cb(err, rs);
    });
  }];

  auto.local_bufs = ["local_readstream", function (cb, response) {
    var bufs = {},
      rs = response.local_readstream;

    cb = _.once(cb);

    if (!rs) {
      return cb(null, bufs);
    }
    rs.on("data", function (data) {
      // TODO: optimization: move compare_bufs here
      bufs[data.value.id] = data.value;
    });
    rs.on("end", function () {
      cb(null, bufs);
    });
    rs.on("error", function (err) {
      log.error("Error in readstream for %s: %s", workspace_id, err);
      cb(err);
    });
  }];

  auto.create_write_stream = ["mkdirp", "local_bufs", function (cb) {
    ldb.write(null, workspace_id, "binary", cb);
  }];

  auto.write_stream_handlers = ["create_write_stream", function (cb, response) {
    cb = _.once(cb);
    response.create_write_stream.once("error", cb);
    response.create_write_stream.once("close", cb);
  }];

  auto.compare_bufs = ["local_bufs", "get_buf_list", "create_write_stream", function (cb, response) {
    var local_bufs = response.local_bufs,
      remote_bufs = response.get_buf_list.bufs,
      to_delete = _.difference(_.keys(local_bufs), _.keys(remote_bufs)),
      to_fetch = [],
      ws = response.create_write_stream;

    cb = _.once(cb);

    _.each(to_delete, function (buf_id) {
      log.debug("Deleting %s/%s", workspace_id, buf_id);
      ws.write({
        key: util.format("buf_%s", buf_id),
        type: "del"
      });
    });

    _.each(remote_bufs, function (rbuf, rbuf_id) {
      var local_buf = local_bufs[rbuf_id];
      if (!local_buf || local_buf.md5 !== rbuf.md5) {
        to_fetch.push(rbuf);
        return;
      }
      if (_.isEqual(local_buf, rbuf)) {
        log.debug("Local copy of %s/%s matches remote. Not fetching.", workspace_id, rbuf.id);
        return;
      }
      to_fetch.push(rbuf);
      ws.write({
        key: util.format("buf_%s", rbuf.id),
        value: {
          id: rbuf.id,
          path: rbuf.path,
          deleted: !!rbuf.deleted,
          md5: rbuf.md5,
          encoding: rbuf.encoding
        },
        valueEncoding: "json"
      });
    });

    return cb(null, to_fetch);
  }];

  auto.get_bufs = ["compare_bufs", function (cb, response) {
    var ws = response.create_write_stream;
    async.eachLimit(response.compare_bufs, 20, function (buf, cb) {
      var options = {
          encoding: null,
          json: false
        },
        url = util.format("%s://%s:%s/workspace/%s/%s", proto, ip, port, workspace_id, buf.id);

      log.debug("Hitting %s", url);
      request.get(url, options, function (err, response, body) {
        var buf_md5;

        if (err) {
          return cb(err, response);
        }

        if (response.statusCode >= 400) {
          return cb(util.format("Code %s from %s. Body: %s", response.statusCode, url, body));
        }

        buf_md5 = utils.md5(body);
        if (buf_md5 !== buf.md5) {
          log.warn("MD5 mismatch: buffer %s content %s metadata %s.", buf.id, buf_md5, buf.md5);
          buf.md5 = buf_md5;
        }
        ws.write({
          key: util.format("buf_%s", buf.id),
          value: {
            id: buf.id,
            path: buf.path,
            deleted: !!buf.deleted,
            md5: buf.md5,
            encoding: buf.encoding
          },
          valueEncoding: "json"
        });
        if (body.length > 0) {
          ws.write({
            key: util.format("buf_content_%s", buf.id),
            value: new Buffer(body),
            valueEncoding: "binary"
          });
        }
        log.debug("Saved %s/%s.", workspace_id, buf.id);
        return cb(null, body);
      });
    }, cb);
  }];

  auto.close_ws = ["get_bufs", function (cb, response) {
    response.create_write_stream.end();
    return cb();
  }];

  async.auto(auto, function (err, response) {
    if (err) {
      log.error("Error fetching workspace %s: %s", workspace_id, err.toString());
      return res.send(500, err.toString());
    }
    if (!_.isFinite(response.get_buf_list.version)) {
      log.error("Workspace %s had bad version: %s", workspace_id, response.get_buf_list.version);
      return res.send(500, util.format("Workspace %s had bad version: %s", workspace_id, response.get_buf_list.version));
    }
    server.db.put(util.format("version_%s", workspace_id), response.get_buf_list.version, function (err) {
      if (err) {
        log.error("Error updating workspace %s version: %s", workspace_id, err.toString());
        return res.send(500, err.toString());
      }
      log.debug("Fetched workspace %s", workspace_id);
      return res.json(200, {
        version: response.get_buf_list.version,
        active: false
      });
    });
  });
};

var motd = function (server, req, res) {
  log.log("MOTD:", req.body);
  server.motd = req.body.msg;
  return res.send(200, req.body.msg);
};

var wallops = function (server, req, res) {
  var msg = "Attention all Floobits users: " + req.body.msg;

  log.log("Wallops:", req.body);
  if (!req.body.msg) {
    log.error("No message. Bad request.");
    return res.send(400, "NEED A MESSAGE");
  }

  _.each(server.agents, function (agent) {
    agent.error(msg, true);
  });

  log.log("Sent wallops to everyone:", msg);
  return res.send(200, msg);
};


var listen = function (port, server) {
  var app = express(),
    auth = express.basicAuth(settings.api_auth.username, settings.api_auth.password),
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


  // Commands. Require auth.
  app.post("/r/:owner/:workspace/evict", auth, evict_workspace.bind(app, server));
  app.post("/r/:owner/:workspace/version", auth, set_workspace_version.bind(app, server));
  app.post("/workspace/:workspace_id/evict", auth, evict_workspace_by_id.bind(app, server));
  app.post("/workspace/:workspace_id/verify", auth, verify_workspace.bind(app, server));
  app.post("/workspace/:workspace_id/version", auth, set_workspace_version_by_id.bind(app, server));
  app["delete"]("/workspace/:workspace_id", auth, delete_workspace_by_id.bind(app, server));
  app.post("/fetch/:workspace_id", auth, fetch_workspace.bind(app, server));
  app.post("/motd", auth, motd.bind(app, server));
  app.post("/wallops", auth, wallops.bind(app, server));

  if (server.cert && server.key) {
    s = https.createServer({
      ca: server.ca,
      cert: server.cert,
      key: server.key
    }, app);
  } else {
    log.warn("No cert info. Using insecure HTTP.");
    s = http.createServer(app);
  }
  s.listen(port);
};


module.exports = {
  listen: listen
};
