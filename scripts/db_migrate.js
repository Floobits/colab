var fs = require("fs");
var path = require("path");
var util = require("util");

var async = require("async");
var knox = require("knox");
var log = require("floorine");
var levelup = require("levelup");
var mkdirp = require("mkdirp");
var _ = require("lodash");

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


var load_s3 = function (key, cb) {
  if (!s3_client) {
    return cb("s3 disabled");
  }
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
  var db_encoding = db.buf_encodings_mapping[buf.encoding] === "utf8" ? "utf8" : "binary";
  ws.write({
    key: util.format("buf_content_%s", buf.fid),
    value: value,
    valueEncoding: db_encoding
  });
};

var migrate_room = function (server_db, db_room, cb) {
  db.query("SELECT * FROM room_buffer WHERE room_id = $1 AND deleted = FALSE", [db_room.id], function (err, result) {
    var checksum_matches = 0,
      db_path,
      room_path;

    room_path = path.normalize(path.join(settings.base_dir, "bufs", db_room.id.toString()));
    db_path = path.join(room_path, "db");
    stats.workspaces.total++;

    if (err) {
      log.error("error getting buffers for room", db_room.id, err);
      stats.workspaces.failed++;
      process.nextTick(function () { cb(err, result); });
      return;
    }

    mkdirp(room_path, function (err) {
      if (err) {
        stats.workspaces.failed++;
        process.nextTick(function () { cb(err); });
        return;
      }
      levelup(db_path, { valueEncoding: "json" }, function (err, ldb) {
        var ws;
        if (err) {
          stats.workspaces.failed++;
          process.nextTick(function () { cb(err); });
          return;
        }
        log.log("%s (%s): migrating %s buffers", db_room.name, room_path, result.rows.length);

        ws = ldb.createWriteStream();

        ws.on("close", function () {
          log.log("Closed db %s", room_path);
          ldb.close(function () {
            process.nextTick(cb);
          });
        });

        ws.on("error", function (err) {
          log.error("Error in db %s: %s", room_path, err);
          if (!ldb.isClosed()) {
            ldb.close(function () {
              stats.workspaces.failed++;
              process.nextTick(function () { cb(err); });
            });
          }
        });

        async.eachLimit(result.rows, 5, function (buf, cb) {
          var auto,
            buf_key = util.format("buf_%s", buf.fid),
            buf_content_key = util.format("buf_content_%s", buf.fid),
            buf_obj,
            buf_path,
            db_encoding = db.buf_encodings_mapping[buf.encoding] === "utf8" ? "utf8" : "binary",
            s3_key;

          buf_obj = {
            id: buf.fid,
            path: buf.path,
            deleted: buf.deleted,
            md5: buf.md5,
            encoding: buf.encoding
          };

          stats.bufs.total++;

          auto = {};

          auto.buf_get = function (cb) {
            ldb.get(buf_key, cb);
          };
          auto.buf_content_get = function (cb) {
            ldb.get(buf_content_key, { valueEncoding: db_encoding }, cb);
          };
          auto.verify_buf = ["buf_get", "buf_content_get", function (cb, response) {
            var buf_md5;
            if (buf.md5 === response.buf_get.md5) {
              if (_.isUndefined(response.buf_content_get)) {
                log.warn("No data in buffer %s! Setting to empty.", buf.fid);
                response.buf_content_get = new Buffer("", db_encoding);
              }
              buf_md5 = utils.md5(response.buf_content_get);
              if (buf_md5 === buf.md5) {
                checksum_matches++;
                return cb(null, true);
              }
              if (buf.md5 === null || response.buf_content_get === "") {
                return cb(null, false);
              }
              log.warn("MD5 mismatch when loading %s! Was %s. Should be %s.", buf.fid, buf_md5, buf.md5);
              stats.bufs.bad_checksum++;
            }
            return cb(null, false);
          }];

          auto.read_buf = ["verify_buf", function (cb, response) {
            if (response.verify_buf) {
              return cb();
            }
            ws.write({
              key: buf_key,
              value: buf_obj
            });
            buf_path = path.join(room_path, buf.fid.toString());
            fs.readFile(buf_path, function (err, result) {
              var buf_md5;
              if (err) {
                log.info("Error reading %s: %s.", buf_path, err);
                return cb(null, false);
              }
              buf_md5 = utils.md5(response.buf_content_get);
              if (buf_md5 === buf.md5) {
                save_buf_content(ws, buf, result);
                return cb(null, true);
              }
              if (buf.md5 === null || response.buf_content_get === "") {
                return cb(null, false);
              }
              log.error("MD5 mismatch when loading off disk %s! Was %s. Should be %s.", buf.fid, buf_md5, buf.md5);
              return cb(null, false);
            });
          }];

          auto.read_s3 = ["read_buf", function (cb, response) {
            if (response.read_buf || response.verify_buf) {
              return cb();
            }
            s3_key = util.format("%s/%s", db_room.id, buf.fid);
            log.log("Fetching %s from s3.", s3_key);
            load_s3(s3_key, function (err, result) {
              if (err) {
                log.error("Error reading %s from s3: %s", s3_key, err);
                stats.bufs.empty++;
                save_buf_content(ws, buf, "");
                cb(err);
                return;
              }
              save_buf_content(ws, buf, result);
              cb();
            });
          }];

          async.auto(auto, function (err) {
            if (err) {
              stats.bufs.failed++;
            }
            cb();
          });
        }, function () {
          server_db.put(util.format("version_%s", db_room.id), checksum_matches);
          ws.end();
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
    log.error("error getting workspaces:", err);
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
