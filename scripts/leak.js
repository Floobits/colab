var path = require("path");
var util = require("util");

var async = require("async");
var log = require("floorine");
var leveldown = require("leveldown");
var levelup = require("levelup");
var _ = require("lodash");

var db = require("db");
var settings = require("settings");
var utils = require("utils");

log.set_log_level(settings.log_level);

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


var migrate_room = function (server_db, db_room, cb) {
  db.query("SELECT * FROM room_buffer WHERE room_id = $1 AND deleted = FALSE", [db_room.id], function (err, result) {
    var db_path,
      room_path;

    room_path = path.normalize(path.join(settings.base_dir, "bufs", db_room.id.toString()));
    db_path = path.join(room_path, "db");
    stats.workspaces.total++;

    if (err) {
      log.error("error getting buffers for room", db_room.id, err);
      stats.workspaces.failed++;
      setImmediate(function () { cb(err, result); });
      return;
    }

    // leveldown.repair(db_path, function () {
    //   log.log("Repaired %s", db_path);
    //   cb();
    // });
    // return;

    levelup(db_path, { cacheSize: 1024 * 1024 * 20, valueEncoding: "json" }, function (err, ldb) {
      if (err) {
        stats.workspaces.failed++;
        setImmediate(function () { cb(err); });
        return;
      }
      log.log("%s (%s): migrating %s buffers", db_room.name, room_path, result.rows.length);

      // global.gc();

      async.eachLimit(result.rows, 5, function (buf, cb) {
        var auto,
          buf_key = util.format("buf_%s", buf.fid),
          buf_content_key = util.format("buf_content_%s", buf.fid),
          db_encoding = db.buf_encodings_mapping[buf.encoding] === "utf8" ? "utf8" : "binary";

        stats.bufs.total++;

        auto = {};

        auto.buf_get = function (cb) {
          ldb.get(buf_key, function (err, result) {
            if (err && err.type !== "NotFoundError") {
              return cb(err, result);
            }
            return cb(null, result);
          });
        };

        auto.buf_content_get = function (cb) {
          ldb.get(buf_content_key, { valueEncoding: db_encoding }, function (err, result) {
            if (err && err.type !== "NotFoundError") {
              return cb(err, result);
            }
            return cb(null, result);
          });
        };

        auto.verify_buf = ["buf_get", "buf_content_get", function (cb, response) {
          var buf_md5;
          if (!response.buf_get) {
            return cb(null, false);
          }
          if (buf.md5 === response.buf_get.md5) {
            if (_.isUndefined(response.buf_content_get)) {
              log.warn("No data in buffer %s! Setting to empty.", buf.fid);
              response.buf_content_get = new Buffer("", db_encoding);
            }
            buf_md5 = utils.md5(response.buf_content_get);
            if (buf_md5 === buf.md5) {
              return cb(null, true);
            }
            if (buf.md5 === null || response.buf_content_get === "") {
              return cb(null, false);
            }
            log.warn("MD5 mismatch when loading %s (%s)! Was %s. Should be %s.", buf.fid, buf.path, buf_md5, buf.md5);
            // log.warn("Buf encoding: %s. Leveldb encoding: %s.", buf.encoding, db_encoding);
            stats.bufs.bad_checksum++;
          }
          return cb(null, false);
        }];

        async.auto(auto, function (err) {
          if (err) {
            stats.bufs.failed++;
          }
          cb();
        });
      }, function () {
        ldb.close(function () {
          setImmediate(cb);
        });
      });
    });
  });
};

var auto = {};

auto.levelup = function (cb) {
  return levelup(path.join(settings.base_dir, "server_db"), cb);
};

auto.rooms = function (cb) {
  return db.query("SELECT * FROM room_room", cb);
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
    console.log("\n");
    if (err) {
      log.error("Error: %s", err);
    }
    console.log("\n");
    log.log("%s workspaces in DB", result.rooms.rows.length);
    final_stats();
  });
});
