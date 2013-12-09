var path = require("path");
var util = require("util");

var async = require("async");
var log = require("floorine");
var levelup = require("levelup");
var mkdirp = require("mkdirp");
var _ = require("lodash");

var db = require("db");
var settings = require("settings");


var migrate_room = function (db_room, cb) {
  db.client.query("SELECT * FROM room_buffer WHERE room_id = $1 AND deleted = FALSE", [db_room.id], function (err, result) {
    var room_path;

    room_path = path.normalize(path.join(settings.buf_storage.local.dir, db_room.id.toString(), "db"));

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
      levelup(room_path, { valueEncoding: "json" }, function (err, ldb) {
        var ws;
        if (err) {
          process.nextTick(function () { cb(err); });
          return;
        }
        log.log("%s: migrating %s buffers", room_path, result.rows.length);

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

        _.each(result.rows, function (buf) {
          var buf_key,
            buf_obj;
          buf_key = util.format("buf_%s", buf.fid);
          buf_obj = {
            id: buf.fid,
            path: buf.path,
            deleted: buf.deleted,
            md5: buf.md5,
            encoding: buf.encoding
          };
          ws.write({
            key: buf_key,
            value: buf_obj
          });
        });
        ws.end();
      });
    });
  });
};

db.connect(function (err, result) {
  if (err) {
    log.error("Error connecting to postgres:", err, result);
    process.exit(1);
  }

  db.client.query("SELECT * FROM room_room", function (err, result) {
    if (err) {
      log.error("error getting workspaces:", err);
      process.exit(1);
    }

    async.eachLimit(result.rows, 20, function (db_room, cb) {
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
});
