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

log.set_log_level(settings.log_level);
var s3_client = knox.createClient(settings.buf_storage.s3);

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
  if (err) {
    console.error("Error:");
    console.error(err);
    console.error("Stack:");
    console.error(err.stack);
  }
  log.log("Migrated %s/%s buffers (%d%)", succeeded, stats.bufs.total, (succeeded / stats.bufs.total) * 100);
  succeeded = (stats.workspaces.total - stats.workspaces.failed);
  log.log("Migrated %s/%s workspaces (%d%)", succeeded, stats.workspaces.total, (succeeded / stats.workspaces.total) * 100);
  process.exit();
};

process.on("exit", final_stats);
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

var migrate_room = function (db_room, cb) {
  db.query("SELECT * FROM room_buffer WHERE room_id = $1 AND deleted = FALSE", [db_room.id], function (err, result) {
    var checksum_matches = 0,
      db_path,
      room_path;

    room_path = path.normalize(path.join(settings.buf_storage.local.dir, db_room.id.toString()));
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
          var buf_content,
            buf_key = util.format("buf_%s", buf.fid),
            buf_obj,
            buf_path,
            s3_key;

          buf_obj = {
            id: buf.fid,
            path: buf.path,
            deleted: buf.deleted,
            md5: buf.md5,
            encoding: buf.encoding
          };

          // Try to fetch from leveldb and compare md5s
          ldb.get(buf_key, function (err, result) {
            if (err) {
              log.error("Error fetching %s from leveldb: %s", buf_key, err);
            } else if (buf.md5 === result.md5) {
              // TODO: actually md5 the data
              log.debug("%s md5 already matches.", buf_key);
              checksum_matches++;
              stats.bufs.total++;
              cb();
              return;
            }

            ws.write({
              key: buf_key,
              value: buf_obj
            });
            stats.bufs.total++;

            buf_path = path.join(room_path, buf.fid.toString());
            try {
              /*jslint stupid: true */
              buf_content = fs.readFileSync(buf_path);
              /*jslint stupid: false */
            } catch (e) {
              s3_key = util.format("%s/%s", db_room.id, buf.fid);
              log.info("Error reading %s: %s.", buf_path, e);
              log.log("Fetching %s from s3.", s3_key);
              load_s3(s3_key, function (err, result) {
                if (err) {
                  log.error("Error reading %s from s3: %s", s3_key, err);
                  save_buf_content(ws, buf, "");
                  stats.bufs.failed++;
                  cb();
                  return;
                }
                save_buf_content(ws, buf, result);
                cb();
              });
              return;
            }
            save_buf_content(ws, buf, buf_content);
            cb();
          });
        }, function () {
          ws.write({
            key: "version",
            value: checksum_matches
          });
          ws.end();
        });
      });
    });
  });
};

db.query("SELECT * FROM room_room", function (err, result) {
  if (err) {
    log.error("error getting workspaces:", err);
    process.exit(1);
  }

  async.eachLimit(result.rows, 5, function (db_room, cb) {
    log.log("Migrating %s", db_room.id);
    migrate_room(db_room, cb);
  }, function (err) {
    if (err) {
      log.error("Error: %s", err);
    }
    log.log("%s workspaces in DB", result.rows.length);
    final_stats();
  });
});
