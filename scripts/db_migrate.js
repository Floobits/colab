var path = require("path");
var util = require("util");

var async = require("async");
var fs = require("fs-extra");
var knox = require("knox");
var log = require("floorine");
var levelup = require("levelup");
var _ = require("lodash");
var DMP = require("native-diff-match-patch");
var diff_match_patch = require('diff_match_patch');
var JS_DMP = new diff_match_patch.diff_match_patch();

var db = require("db");
var settings = require("settings");
var utils = require("utils");

var s3_client;

log.set_log_level(settings.log_level);

if (settings.s3) {
  s3_client = knox.createClient(settings.s3);
} else {
  log.warn("No S3 settings! Only migrating local data.");
}
settings.bufs_dir = path.join(settings.base_dir, "bufs");


var load_s3 = function (key, cb) {
  var req = s3_client.get(key);

  req.on("response", function (res) {
    var data = "";
    res.setEncoding("binary");
    if (res.statusCode >= 400) {
      return cb(util.format("Bad status code from S3: %s", res.statusCode));
    }
    res.on("data", function (chunk) {
      data += chunk;
    });
    res.on("end", function () {
      cb(null, data);
    });
    res.on("error", cb);
  });
  req.on("error", function (err, result) {
    cb(err, result);
  });
  req.end();
};

var stats = {
  bufs: {
    bad_checksum: 0,
    empty: 0,
    failed: 0,
    total: 0
  },
  workspaces: {
    failed: 0,
    total: 0
  }
};

var migrated_rooms = [];

var final_stats = function (err) {
  var succeeded = (stats.bufs.total - stats.bufs.failed);
  console.log("\n");
  if (err) {
    console.error("Error:");
    console.error(err);
    console.error("Stack:");
    console.error(err.stack);
  }
  console.log("\n");
  log.log("Migrated %s/%s buffers (%d%)", succeeded, stats.bufs.total, (succeeded / stats.bufs.total) * 100);
  succeeded = (stats.workspaces.total - stats.workspaces.failed);
  log.log("%s bad checksums (%d%)", stats.bufs.bad_checksum, (stats.bufs.bad_checksum / stats.bufs.total) * 100);
  log.log("%s empty (%d%)", stats.bufs.empty, (stats.bufs.empty / stats.bufs.total) * 100);
  log.log("Migrated %s/%s workspaces (%d%)", succeeded, stats.workspaces.total, (succeeded / stats.workspaces.total) * 100);
  process.exit();
};

process.on("uncaughtException", final_stats);
process.on("SIGINT", final_stats);
process.on("SIGTERM", final_stats);

var save_buf_content = function (ws, buf, value) {
  buf.md5 = utils.md5(value);
  ws.write({
    key: util.format("buf_%s", buf.id),
    value: buf
  });
  if (value.length === 0) {
    ws.write({
      key: util.format("buf_content_%s", buf.id),
      type: "del"
    });
    return;
  }
  ws.write({
    key: util.format("buf_content_%s", buf.id),
    value: value,
    valueEncoding: "binary"
  });
};

var migrate_room = function (server_db, db_room, cb) {
  var auto = {},
    room_path = path.normalize(path.join(settings.bufs_dir, db_room.id.toString())),
    db_path = path.join(room_path, "db");

  stats.workspaces.total++;

  auto.db_bufs = function (cb) {
    db.query("SELECT * FROM room_buffer WHERE room_id = $1 AND deleted = FALSE", [db_room.id], cb);
  };

  auto.mkdir = function (cb) {
    fs.mkdirs(room_path, cb);
  };

  auto.ldb = ["mkdir", function (cb) {
    levelup(db_path, { valueEncoding: "json" }, cb);
  }];

  auto.migrate_bufs = ["db_bufs", "ldb", function (cb, res) {
    var checksum_matches = 0,
      db_bufs = res.db_bufs,
      ldb = res.ldb,
      ws;

    cb = _.once(cb);

    log.log("%s (%s): migrating %s buffers", db_room.name, room_path, db_bufs.rows.length);
    ws = ldb.createWriteStream();
    ws.on("close", function () {
      log.debug("Closed db %s", room_path);
      ldb.close(function () {
        cb(null, checksum_matches);
      });
    });

    ws.on("error", function (err) {
      log.error("Error in db %s: %s", room_path, err);
      if (!ldb.isClosed()) {
        ldb.close(function () {
          cb(err);
        });
      }
    });

    async.eachLimit(db_bufs.rows, 20, function (buf, cb) {
      var buf_auto,
        buf_key = util.format("buf_%s", buf.fid),
        buf_content_key = util.format("buf_content_%s", buf.fid),
        buf_obj,
        buf_path;

      buf_obj = {
        id: buf.fid,
        path: buf.path,
        deleted: buf.deleted,
        md5: buf.md5,
        encoding: buf.encoding
      };

      stats.bufs.total++;

      buf_auto = {};

      buf_auto.buf_get = function (cb) {
        ldb.get(buf_key, function (err, result) {
          if (err && err.type !== "NotFoundError") {
            return cb(err, result);
          }
          return cb(null, result);
        });
      };

      buf_auto.buf_content_get = function (cb) {
        ldb.get(buf_content_key, { valueEncoding: "binary" }, function (err, result) {
          if (err && err.type !== "NotFoundError") {
            return cb(err, result);
          }
          return cb(null, result);
        });
      };

      buf_auto.verify_buf = ["buf_get", "buf_content_get", function (cb, response) {
        var buf_md5;
        if (!response.buf_get) {
          return cb(null, false);
        }
        if (buf.md5 === response.buf_get.md5) {
          if (_.isUndefined(response.buf_content_get)) {
            // If buffer content is empty, this is expected
            log.debug("No data in %s/%s. Setting to empty.", buf.room_id, buf.fid);
            response.buf_content_get = new Buffer(0);
          }
          buf_md5 = utils.md5(response.buf_content_get);
          if (buf_md5 === buf.md5) {
            return cb(null, true);
          }
          if (buf.md5 === null || response.buf_content_get === "") {
            log.warn("buf md5 is %s. response.buf_content_get is '%s'", buf.md5, response.buf_content_get);
            return cb(null, false);
          }
          // Empty buf
          if (buf_md5 === "d41d8cd98f00b204e9800998ecf8427e") {
            stats.bufs.empty++;
            return cb(null, false);
          }
          log.warn("MD5 mismatch when loading %s (%s)! Was %s. Should be %s.", buf.fid, buf.path, buf_md5, buf.md5);
          stats.bufs.bad_checksum++;
        }
        return cb(null, false);
      }];

      buf_auto.read_buf = ["verify_buf", function (cb, response) {
        if (response.verify_buf) {
          return cb();
        }
        buf_path = path.join(room_path, buf.fid.toString());
        fs.readFile(buf_path, function (err, result) {
          var buf_md5;

          if (err) {
            log.info("Error reading %s: %s.", buf_path, err);
            return cb(null, false);
          }
          buf_md5 = utils.md5(result);
          if (buf_md5 === buf.md5) {
            save_buf_content(ws, buf_obj, result);
            if (response.buf_content_get) {
              log.warn("lengths: db: %s file: %s", _.size(response.buf_content_get), result.length);
            }
            return cb(null, true);
          }
          if (response.buf_content_get && buf_md5 === utils.md5(response.buf_content_get)) {
            log.warn("File and leveldb agree, but postgres doesn't.");
            save_buf_content(ws, buf_obj, result);
            return cb(null, true);
          }
          if (buf.md5 === null || result === "") {
            log.error("buf md5 is %s. result is '%s'", buf.md5, result);
            return cb(null, false);
          }
          log.error("MD5 mismatch when loading %s %s off disk! Was %s. Should be %s.", buf.fid, buf.path, buf_md5, buf.md5);
          stats.bufs.bad_checksum++;
          if (response.buf_content_get) {
            log.warn("lengths: db: %s file: %s", _.size(response.buf_content_get), _.size(result));
          }
          save_buf_content(ws, buf_obj, result);
          return cb(null, false);
        });
      }];

      buf_auto.read_s3 = ["read_buf", function (cb, response) {
        var s3_key;
        if (response.read_buf || response.verify_buf) {
          checksum_matches++;
          return cb();
        }
        if (!s3_client) {
          stats.bufs.bad_checksum++;
          return cb();
        }
        s3_key = util.format("%s/%s", db_room.id, buf.fid);
        log.debug("Fetching %s from s3.", s3_key);
        load_s3(s3_key, function (err, result) {
          var buf_md5;
          if (err) {
            log.error("Error reading %s from s3: %s", s3_key, err);
            stats.bufs.empty++;
          } else {
            buf_md5 = utils.md5(result);
            if (buf_md5 !== buf.md5) {
              log.error("MD5 mismatch when loading %s %s from s3! Was %s. Should be %s.", buf.fid, buf.path, buf_md5, buf.md5);
            }
            save_buf_content(ws, buf_obj, result);
          }
          cb(err);
        });
      }];

      async.auto(buf_auto, function (err) {
        if (err) {
          stats.bufs.failed++;
        }
        cb();
      });
    }, function (err) {
      var version_key = util.format("version_%s", db_room.id);
      if (err) {
        log.error("Error migrating %s: %s", db_room.id, err);
        process.exit(1);
        server_db.put(version_key, -1, function () {
          ws.end();
        });
      } else {
        server_db.put(version_key, checksum_matches, function () {
          ws.end();
        });
      }
    });
  }];

  async.auto(auto, function (err, result) {
    if (err) {
      log.error("error getting buffers for room", db_room.id, err);
      stats.workspaces.failed++;
    } else {
      migrated_rooms.push(db_room.id);
    }
    return cb(err, result);
  });
};

var auto = {};

auto.levelup = function (cb) {
  return levelup(path.join(settings.base_dir, "server_db"), cb);
};

auto.rooms = function (cb) {
  var query = "SELECT * FROM room_room",
    workspace_ids = process.argv.slice(2);

  if (workspace_ids.length > 0) {
    query += util.format(" WHERE id in (%s)", workspace_ids.join(", "));
    settings.move_dead_workspaces = false;
  } else {
    settings.move_dead_workspaces = true;
  }

  return db.query(query, cb);
};

async.auto(auto, function (err, result) {
  if (err) {
    log.error("Error getting workspaces: %s", err.toString());
    process.exit(1);
  }

  async.eachLimit(result.rooms.rows, 5, function (db_room, cb) {
    log.debug("Migrating %s", db_room.id);
    migrate_room(result.levelup, db_room, cb);
  }, function (err) {
    if (err) {
      log.error("Error: %s", err);
    }

    fs.readdir(settings.bufs_dir, function (err, workspaces) {
      var dead_workspaces_path = path.normalize(path.join(settings.bufs_dir, "old_bufs"));
      if (err) {
        log.error("Error reading %s: %s", settings.bufs_dir, err);
      }
      _.each(workspaces, function (workspace) {
        var workspace_id = parseInt(workspace, 10),
          old_path = path.join(settings.bufs_dir, workspace),
          p = path.join(dead_workspaces_path, workspace);
        if (!_.isFinite(workspace_id)) {
          log.warn("No clue wtf %s is doing in here.", workspace);
          return;
        }
        if (!_.contains(migrated_rooms, workspace_id) && settings.move_dead_workspaces) {
          /*jslint stupid: true */
          fs.mkdirsSync(dead_workspaces_path);
          log.error("%s on disk but not migrated. Moving to %s", workspace, dead_workspaces_path);
          fs.renameSync(old_path, p);
          /*jslint stupid: false */
        }
      });
      log.log("%s workspaces in DB", result.rooms.rows.length);
      final_stats();
    });
  });
});
