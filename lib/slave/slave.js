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
var request = require("request");

var ldb = require("../ldb");
var RoomEvent = require("../room_event");
var settings = require("../settings");
var utils = require("../utils");

var CPUS = _.size(os.cpus());
var TOTAL_MEM = os.totalmem();

request = request.defaults(_.merge(settings.request_defaults, {
  strictSSL: false
}));


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
    } else {
      workspaces[workspace_id] = {
        active: false,
        id: workspace_id,
        version: parseInt(data.value, 10)
      };
    }
  });
};

var create_workspace = function (server, workspace_id, version, cb) {
  var auto = {};

  auto.check_exists = function (cb) {
    server.db.get(util.format("version_%s", workspace_id), function (err, result) {
      if (!err && result) {
        return cb("already_exists");
      }
      return cb();
    });
  };
  auto.set_version = ["check_exists", function (cb) {
    server.db.put(util.format("version_%s", workspace_id), version, cb);
  }];
  auto.mkdirp = function (cb) {
    fs.mkdirs(ldb.get_db_path(workspace_id), cb);
  };
  auto.create_db = ["mkdirp", function (cb) {
    ldb.get_db(null, workspace_id, {
      createIfMissing: true,
      valueEncoding: "json",
    }, cb);
  }];
  async.auto(auto, function (err, result) {
    var msg;
    if (result.create_db) {
      ldb.finish_db(result.create_db, workspace_id);
    }
    if (err) {
      if (err === "already_exists") {
        return cb(util.format("Workspace %s already exists.", workspace_id));
      }
      msg = util.format("Error creating workspace %s: %s", workspace_id, err);
      log.error(msg);
      return cb(msg);
    }

    return cb(null, {
      id: workspace_id,
      version: version,
      active: false,
    });
    // CB()
  });
};

var delete_workspace = function (server, workspace_id, username, cb) {
  var auto = {},
    db = ldb.open_dbs[workspace_id],
    reason = "This workspace was deleted.",
    workspace = server.workspaces[workspace_id],
    workspace_path = path.normalize(path.join(settings.bufs_dir, util.format("%s", workspace_id)));

  if (workspace_path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Bufs dir: %s", workspace_path, settings.bufs_dir);
    return cb("Error code 93897.");
  }

  auto.exists = function (cb) {
    fs.exists(workspace_path, function (exists) {
      return cb(null, exists);
    });
  };

  auto.del_db = ["exists"];

  if (workspace) {
    if (username) {
      reason = util.format("%s deleted this workspace.", username);
    }
    auto.evict = ["exists", function (cb) {
      workspace.evict(reason, cb);
    }];
    auto.del_db.push("evict");
  }

  if (db) {
    auto.del_db.push("close_db");
    auto.close_db = ["exists"];
    if (auto.evict) {
      auto.close_db.push("evict");
    }
    auto.close_db.push(function (cb) {
      ldb.close_db(db, workspace_id, cb);
    });
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
      return cb(err);
    }
    return cb(null, result);
  });
};

var evict_workspace = function (server, workspace_id, reason, cb) {
  var workspace = server.workspaces[workspace_id];

  if (!workspace) {
    return cb("Workspace is not active on this server.");
  }
  return workspace.evict(reason, cb);
};

// Fetch a workspace from another server
var fetch_workspace = function (server, workspace_id, proto, ip, port, cb) {
  var auto = {};

  if (server.workspaces[workspace_id]) {
    // TODO: make it ok to fetch active workspaces
    return cb(util.format("Workspace %s is active!", workspace_id));
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

  auto.del_local_events = ["mkdirp", function (cb) {
    ldb.read_events(null, workspace_id, function (err, rs) {
      var actions = [];
      if (err) {
        if (err.type === "OpenError" && err.message && err.message.indexOf("does not exist") > 0) {
          // Squelch "DB doesn't exist" error
          err = null;
        } else {
          log.warn("Error reading local db %s: %s", workspace_id, err);
        }
      }
      if (!rs) {
        log.warn("no readstream for %s, %s", workspace_id, err);
        return cb(err);
      }
      rs.on("data", function (data) {
        actions.push({
          type: "del",
          key: data.key
        });
      });
      rs.on("end", function () {
        ldb.get_db(null, workspace_id, null, function (err, db) {
          if (err) {
            return cb(err);
          }
          db.batch(actions, function (batch_err) {
            ldb.close_db(db, workspace_id, function (err) {
              return cb(batch_err || err);
            });
          });
        });
      });
    });
  }];

  auto.local_readstream = ["del_local_events", function (cb) {
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

  auto.local_bufs = ["local_readstream", "del_local_events", function (cb, response) {
    var bufs = {},
      rs = response.local_readstream;

    cb = _.once(cb);

    if (!rs) {
      return cb(null, bufs);
    }
    rs.on("data", function (data) {
      var value = data.value;
      try {
        value = JSON.parse(value);
      } catch (e) {
        log.error("Error parsing %s: %s", data, e);
        return;
      }
      // TODO: optimization: move compare_bufs here
      bufs[value.id] = value;
    });
    rs.on("end", function () {
      cb(null, bufs);
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
      rbuf.deleted = !!rbuf.deleted;
      if (!local_buf || local_buf.md5 !== rbuf.md5) {
        to_fetch.push(rbuf);
        return;
      }
      if (_.isEqual(local_buf, rbuf)) {
        log.debug("Local copy of %s/%s matches remote. Not fetching.", workspace_id, rbuf.id);
        return;
      }
      log.log("Local copy of %s/%s differs from remote. Fetching.", workspace_id, rbuf.id);
      log.debug("local: %s remote %s", _.keys(local_buf), _.keys(rbuf));

      to_fetch.push(rbuf);
      ws.write({
        key: util.format("buf_%s", rbuf.id),
        value: {
          id: rbuf.id,
          path: rbuf.path,
          deleted: rbuf.deleted,
          md5: rbuf.md5,
          encoding: rbuf.encoding
        },
        valueEncoding: "json",
      });
    });

    return cb(null, to_fetch);
  }];

  auto.get_bufs = ["compare_bufs", function (cb, response) {
    var ws = response.create_write_stream;

    _.each(response.get_buf_list.events, function (row) {
      var evt = new RoomEvent(row);
      log.debug("Writing room event: %s", JSON.stringify(evt.to_json()));
      ws.write({
        key: util.format("event_%s", evt.id),
        value: evt.to_json(),
        valueEncoding: "json",
      });
    });

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
          valueEncoding: "json",
        });
        if (body.length > 0) {
          ws.write({
            key: util.format("buf_content_%s", buf.id),
            value: new Buffer(body),
            valueEncoding: "binary",
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
      return cb(err.toString());
    }
    if (!_.isFinite(response.get_buf_list.version)) {
      log.error("Workspace %s had bad version: %s", workspace_id, response.get_buf_list.version);
      return cb(util.format("Workspace %s had bad version: %s", workspace_id, response.get_buf_list.version));
    }
    server.db.put(util.format("version_%s", workspace_id), response.get_buf_list.version, function (err) {
      if (err) {
        log.error("Error updating workspace %s version: %s", workspace_id, err.toString());
        return cb(err);
      }
      log.debug("Fetched workspace %s", workspace_id);
      return cb(null, {
        version: response.get_buf_list.version,
        active: false
      });
    });
  });
};

var get_workspace = function (server, workspace_id, opts, cb) {
  var auto = {},
    workspace = server.workspaces[workspace_id],
    workspace_json;

  if (_.size(opts) > 0) {
    // TODO: accept opts for key depth? include bufs? merkle tree? etc?
    return cb("Bad opts!");
  }

  if (workspace) {
    workspace_json = workspace.to_json();
    workspace_json.events = workspace.events;
    workspace_json.version = workspace.version;
    return cb(null, workspace_json);
  }

  auto.version = function (cb) {
    server.db.get(util.format("version_%s", workspace_id), cb);
  };

  auto.db = function (cb) {
    ldb.get_db(null, workspace_id, null, cb);
  };

  auto.rs = ["version", "db", function (cb, response) {
    ldb.read_buf_info(response.db, workspace_id, cb);
  }];

  auto.bufs = ["rs", function (cb, response) {
    var bufs = {},
      rs = response.rs;

    cb = _.once(cb);

    rs.on("data", function (data) {
      var value = data.value;
      try {
        value = JSON.parse(value);
      } catch (e) {
        log.error("Error parsing %s: %s", data, e);
        return;
      }

      if (value.deleted) {
        // TODO: one day, replicate deleted bufs
        return;
      }

      bufs[value.id] = {
        id: value.id,
        path: value.path,
        deleted: value.deleted,
        md5: value.md5,
        encoding: value.encoding
      };
    });
    rs.on("close", function () {
      return cb(null, bufs);
    });
  }];

  auto.events_rs = ["version", "db", function (cb, response) {
    ldb.read_events(response.db, workspace_id, cb);
  }];

  auto.events = ["events_rs", function (cb, response) {
    var events = [],
      rs = response.events_rs;

    cb = _.once(cb);

    rs.on("close", function () {
      return cb(null, events);
    });
    rs.on("error", function (err, data) {
      // This is bad, but don't completely die (but really, this is really bad)
      log.error("Error loading %s: %s", err, data);
    });
    rs.on("data", function (data) {
      var evt,
        evt_id,
        row = data.value;
      try {
        row = JSON.parse(row);
      } catch (e) {
        log.error("Error parsing %s: %s", data, e);
        return;
      }
      evt_id = parseInt(data.key.split("_")[1], 10);
      try {
        evt = new RoomEvent(evt_id, row.name, row.data);
        events.push(evt);
      } catch (e) {
        // old, invalid event. nuke it
        response.db.del(data.key, function (err) {
          if (err) {
            log.error("ERROR DELETING", evt_id);
          }
          log.warn("Deleted", evt_id);
        });
        log.error(e);
      }
    });
  }];

  async.auto(auto, function (err, result) {
    var tree = {};
    if (result.db) {
      ldb.finish_db(result.db, workspace_id);
    }
    if (err) {
      return cb(err);
    }
    _.each(result.bufs, function (buf) {
      if (buf.deleted) {
        return;
      }
      utils.tree_add_buf(tree, buf.path, buf.id);
    });
    return cb(null, {
      bufs: result.bufs,
      events: result.events,
      tree: tree,
      version: parseInt(result.version, 10)
    });
  });
};

var update_workspace = function (server, workspace_id, data, cb) {
  var workspace = server.workspaces[workspace_id];

  // TODO: load workspace off disk, then update it
  if (!workspace) {
    return cb("Workspace not active.");
  }
  // TODO: support updating more attrs
  if (!_.isFinite(data.version)) {
    return cb("Bad version");
  }
  workspace.version = data.version;
  workspace.save(cb);
};


module.exports = {
  get_load: get_load,
  all_workspaces: all_workspaces,
  create_workspace: create_workspace,
  delete_workspace: delete_workspace,
  evict_workspace: evict_workspace,
  fetch_workspace: fetch_workspace,
  get_workspace: get_workspace,
  update_workspace: update_workspace,
};
