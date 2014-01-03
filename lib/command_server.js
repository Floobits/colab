var http = require("http");
var https = require("https");
var path = require("path");
var util = require("util");

var async = require("async");
var express = require("express");
var fs = require("fs-extra");
var log = require("floorine");
var request = require("request");
var _ = require("lodash");

var db = require("./db");
var ldb = require("./ldb");
var settings = require("./settings");
var utils = require("./utils");


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

var delete_workspace = function (server, req, res) {
  var reason = "This workspace was deleted.",
    workspace = load_workspace(server, req.params.workspace, req.params.owner);

  if (!workspace) {
    return res.send(404);
  }

  if (req.body && req.body.username) {
    reason = util.format("%s deleted this workspace.", req.body.username);
  }
  workspace.evict(reason);

  // TODO: do something about the callback
  server.db.del(util.format("version_%s", workspace.id));

  if (workspace.path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Bufs dir: %s", workspace.path, settings.bufs_dir);
    return res.send(500);
  }

  fs.remove(workspace.path, function (err) {
    if (err) {
      return res.send(500, err);
    }
    return res.send(204);
  });
};

var delete_workspace_by_id = function (server, req, res) {
  var reason = "This workspace was deleted.",
    workspace_id = req.params.workspace_id,
    workspace = server.workspaces[workspace_id],
    workspace_path = path.normalize(path.join(settings.bufs_dir, workspace_id));

  if (workspace) {
    if (req.body && req.body.username) {
      reason = util.format("%s deleted this workspace.", req.body.username);
    }
    workspace.evict(reason);
  }

  // TODO: check if workspace is active and evict and all that
  if (workspace_path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Bufs dir: %s", workspace_path, settings.bufs_dir);
    return res.send(500);
  }

  fs.exists(workspace_path, function (exists) {
    if (!exists) {
      return res.send(404);
    }
    // TODO: do something about the callback
    server.db.del(util.format("version_%s", workspace_id));

    fs.remove(workspace_path, function (err) {
      if (err) {
        return res.send(500, err);
      }
      return res.send(204);
    });
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

// Fetch a workspace from another server
var fetch_workspace = function (server, req, res) {
  var auto = {},
    ip = req.body.ip,
    options = {
      json: true
    },
    port = req.body.port,
    proto = req.body.proto || "http",
    workspace_id = req.params.workspace_id;

  // TODO: validate req.body

  if (server.workspaces[workspace_id]) {
    // TODO: make it ok to fetch active workspaces?
    return res.send(400, util.format("Workspace %s is active!", workspace_id));
  }

  auto.get_buf_list = function (cb) {
    var url = util.format("%s://%s:%s/workspace/%s", proto, ip, port, workspace_id);
    log.debug("hitting %s", url);
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

  auto.create_write_stream = ["mkdirp", function (cb) {
    ldb.write(null, workspace_id, "binary", cb);
  }];

  auto.local_readstream = ["mkdirp", function (cb) {
    ldb.read_buf_info(null, workspace_id, function (err, rs) {
      if (err) {
        log.error("Error reading local db %s: %s", workspace_id, err);
        return cb();
      }
      return cb(err, rs);
    });
  }];

  auto.local_bufs = ["local_readstream", function (cb, response) {
    var bufs = {},
      rs = response.local_readstream;
    if (!rs) {
      return cb(null, bufs);
    }
    rs.on("data", function (data) {
      bufs[data.value.id] = data.value;
    });
    rs.on("end", function () {
      cb(null, bufs);
      cb = function () { return; };
    });
    rs.on("error", function (err) {
      log.error("Error in readstream for %s: %s", workspace_id, err);
      cb(null, bufs);
      cb = function () { return; };
    });
  }];

  auto.compare_bufs = ["local_bufs", "get_buf_list", "create_write_stream", function (cb, response) {
    var local_bufs = response.local_bufs,
      remote_bufs = response.get_buf_list.bufs,
      to_delete = _.difference(_.keys(local_bufs), _.keys(remote_bufs)),
      to_fetch = [],
      ws = response.create_write_stream;

    ws.on("error", function (err) {
      // TODO: don't be stupid here
      return res.send(500, err.toString());
    });

    _.each(to_delete, function (buf_id) {
      ws.write({
        key: util.format("buf_%s", buf_id),
        type: "del"
      });
    });

    _.each(remote_bufs, function (rbuf, rbuf_id) {
      var local_buf = local_bufs[rbuf_id];
      if (!local_buf) {
        return;
      }
      if (local_buf.md5 !== rbuf.md5) {
        to_fetch.push(rbuf);
        return;
      }
      if (_.isEqual(local_buf, rbuf)) {
        return;
      }
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
      var url = util.format("%s://%s:%s/workspace/%s/%s", proto, ip, port, workspace_id, buf.id);
      log.debug("hitting %s", buf, url);
      options = {
        json: true
      };
      request.get(url, options, function (err, response, body) {
        var buf_md5 = utils.md5(body),
          db_encoding = db.buf_encodings_mapping[buf.encoding] === "utf8" ? "utf8" : "binary";
        if (err) {
          return cb(err, response);
        }
        if (response.statusCode >= 400) {
          return cb(util.format("Code %s from %s", response.statusCode, url));
        }
        if (buf_md5 !== buf.md5) {
          log.warn("Md5 mismatch: buffer %s content %s metadata %s.", buf.id, buf_md5, buf.md5);
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
        ws.write({
          key: util.format("buf_content_%s", buf.id),
          value: body,
          valueEncoding: db_encoding
        });
        return cb(null, body);
      });
    }, cb);
  }];

  async.auto(auto, function (err, result) {
    if (result.create_write_stream) {
      result.create_write_stream.end();
    }
    if (err) {
      return res.send(500, err.toString());
    }
    log.debug(result);
    return res.send(204);
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
    s;

  app.use(express.bodyParser());
  app.use(express.logger());
  app.use(express.basicAuth(settings.command_auth.username, settings.command_auth.password));

  app["delete"]("/r/:owner/:workspace", delete_workspace.bind(app, server));
  app.post("/r/:owner/:workspace/evict", evict_workspace.bind(app, server));
  app.post("/r/:owner/:workspace/version", set_workspace_version.bind(app, server));

  app["delete"]("/workspace/:workspace_id", delete_workspace_by_id.bind(app, server));
  app.post("/fetch/:workspace_id", fetch_workspace.bind(app, server));
  app.post("/motd", motd.bind(app, server));
  app.post("/wallops", wallops.bind(app, server));

  if (server.cert && server.key) {
    s = https.createServer({
      ca: server.ca,
      cert: server.cert,
      key: server.key
    }, app);
  } else {
    s = http.createServer(app);
  }
  s.listen(port);
};

exports.listen = listen;
