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

var bufs = {
  failed: 0,
  total: 0
};

var final_stats = function () {
  var succeeded = (bufs.total - bufs.failed);
  log.log("Migrated %s/%s buffers (%d%)", succeeded, bufs.total, (succeeded / bufs.total) * 100);
  process.exit();
};

process.on("exit", final_stats);
process.on("uncaughtException", final_stats);
process.on("SIGINT", final_stats);
process.on("SIGTERM", final_stats);


var migrate_room = function (db_room, cb) {
  db.query("SELECT * FROM room_buffer WHERE room_id = $1 AND deleted = FALSE", [db_room.id], function (err, result) {
    var db_path,
      room_path;

    room_path = path.normalize(path.join(settings.buf_storage.local.dir, db_room.id.toString()));
    db_path = path.join(room_path, "db");

    if (err) {
      log.error("error getting buffers for room", db_room.id, err);
      process.nextTick(function () { cb(err, result); });
      return;
    }

    mkdirp(room_path, function (err) {
      if (err) {
        process.nextTick(function () { cb(err); });
        return;
      }
      levelup(db_path, { valueEncoding: "json" }, function (err, ldb) {
        var ws;
        if (err) {
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
              process.nextTick(function () { cb(err); });
            });
          }
        });

        async.eachLimit(result.rows, 1, function (buf, cb) {
          var buf_content,
            buf_obj,
            buf_path,
            db_encoding,
            s3_key;
          buf_obj = {
            id: buf.fid,
            path: buf.path,
            deleted: buf.deleted,
            md5: buf.md5,
            encoding: buf.encoding
          };
          ws.write({
            key: util.format("buf_%s", buf.fid),
            value: buf_obj
          });
          bufs.total++;

          buf_path = path.join(room_path, buf.fid.toString());
          try {
            /*jslint stupid: true */
            buf_content = fs.readFileSync(buf_path);
            /*jslint stupid: false */
          } catch (e) {
            s3_key = util.format("%s/%s", db_room.id, buf.fid);
            log.error("Error reading %s: %s.", buf_path, e);
            log.log("Fetching %s from s3.", s3_key);
            load_s3(s3_key, function (err, result) {
              if (err) {
                log.error("Error reading %s from s3: %s", s3_key, err);
                // Die because otherwise there would be data loss.
                // process.exit(1);
                result = " ";
                bufs.failed++;
              }
              db_encoding = db.buf_encodings_mapping[buf.encoding] === "utf8" ? "utf8" : "binary";
              ws.write({
                key: util.format("buf_content_%s", buf.fid),
                value: result,
                valueEncoding: db_encoding
              });
              cb();
            });
            return;
          }
          db_encoding = db.buf_encodings_mapping[buf.encoding] === "utf8" ? "utf8" : "binary";
          ws.write({
            key: util.format("buf_content_%s", buf.fid),
            value: buf_content,
            valueEncoding: db_encoding
          });
          cb();
        }, function () {
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

  // var rows = result.rows.slice(0, 20);

  async.eachLimit(result.rows, 1, function (db_room, cb) {
    log.log("Migrating %s", db_room.id);
    migrate_room(db_room, cb);
  }, function (err) {
    if (err) {
      log.error("Error: %s", err);
    }
    log.log("Migrated %s workspaces", result.rows.length);
    process.exit(1);
  });
});
