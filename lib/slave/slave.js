"use strict";

var child_process = require("child_process");
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


function get_load(cb) {
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
}

function all_workspaces(server, cb) {
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
      workspaces[workspace_id] = workspace.to_master_json();
    } else {
      workspaces[workspace_id] = {
        active: false,
        id: workspace_id,
        version: parseInt(data.value, 10)
      };
    }
  });
}

function mkdirp(workspace_id, cb) {
  return fs.mkdirs(ldb.get_db_path(workspace_id), cb);
}

function create_workspace(server, workspace_id, version, create_cb) {
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
    mkdirp(workspace_id, cb);
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
        return create_cb(util.format("Workspace %s already exists.", workspace_id));
      }
      msg = util.format("Error creating workspace %s: %s", workspace_id, err);
      log.error(msg);
      return create_cb(msg);
    }

    return create_cb(null, {
      id: workspace_id,
      version: version,
      active: false,
    });
  });
}

function delete_workspace(server, workspace_id, username, del_cb) {
  var auto = {},
    db = ldb.open_dbs[workspace_id],
    reason = "This workspace was deleted.",
    workspace = server.workspaces[workspace_id],
    workspace_path = path.normalize(path.join(settings.bufs_dir, util.format("%s", workspace_id)));

  if (workspace_path.indexOf(settings.bufs_dir) !== 0) {
    log.error("Security violation! Workspace path: %s. Bufs dir: %s", workspace_path, settings.bufs_dir);
    return del_cb("Error code 93897.");
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
      return del_cb(err, result);
    }
    return del_cb(null, result);
  });
}

function evict_workspace(server, workspace_id, reason, cb) {
  var workspace = server.workspaces[workspace_id];

  if (!workspace) {
    return cb("Workspace is not active on this server.");
  }
  return workspace.evict(reason, cb);
}

function get_workspace(server, workspace_id, opts, get_cb) {
  var auto = {},
    workspace = server.workspaces[workspace_id],
    workspace_json;

  if (_.size(opts) > 0) {
    // TODO: accept opts for key depth? include bufs? merkle tree? etc?
    return get_cb("Bad opts!");
  }

  if (workspace) {
    workspace_json = workspace.room_info();
    workspace_json.events = workspace.events;
    workspace_json.version = workspace.version;
    return get_cb(null, workspace_json);
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
      return get_cb(err);
    }
    _.each(result.bufs, function (buf) {
      if (buf.deleted) {
        return;
      }
      utils.tree_add_buf(tree, buf.path, buf.id);
    });
    return get_cb(null, {
      bufs: result.bufs,
      events: result.events,
      tree: tree,
      version: parseInt(result.version, 10)
    });
  });
}

function update_workspace(server, workspace_id, data, cb) {
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
}

function verify_workspace(server, workspace_id, data, verify_cb) {
  var auto = {},
    errs = [];

  auto.server_db = function (cb) {
    server.db.get(util.format("version_%s", workspace_id), cb);
  };

  auto.db = ["server_db", function (cb) {
    ldb.get_db(null, workspace_id, null, cb);
  }];

  auto.verify_bufs = ["db", function (cb, res) {
    var db = res.db,
      brs;

    brs = db.createReadStream({
      start: "buf_",
      end: "buf_999999999999",
      valueEncoding: "json"
    });

    brs.on("data", function (brs_data) {
      var buf_id = parseInt(brs_data.key.slice(4), 10),
        expected_md5 = brs_data.value.md5;
      db.get(util.format("buf_content_%s", buf_id), { valueEncoding: "binary" }, function (err, result) {
        var md5;
        if (err) {
          if (err.type === "NotFoundError") {
            err = null;
            result = new Buffer(0);
          }
        }
        md5 = utils.md5(result);
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
        if (err) {
          errs.push(err);
        }
      });
    });
    brs.on("close", cb);
  }];

  async.auto(auto, function (err, result) {
    if (result.db) {
      ldb.finish_db(result.db, workspace_id);
    }
    if (err) {
      if (err.type === "NotFoundError") {
        return verify_cb(err);
      }
      errs.push(err);
    }
    if (errs.length > 0) {
      return verify_cb(errs);
    }
    return verify_cb();
  });
}


module.exports = {
  all_workspaces: all_workspaces,
  create_workspace: create_workspace,
  delete_workspace: delete_workspace,
  evict_workspace: evict_workspace,
  get_load: get_load,
  get_workspace: get_workspace,
  mkdirp: mkdirp,
  update_workspace: update_workspace,
  verify_workspace: verify_workspace,
};
