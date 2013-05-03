var util = require("util");

var async = require("async");
var _ = require("underscore");

var db = require("./db");
var s3 = require("./s3");
var s3_client = s3.get_client();


async.auto({
  db: function (cb) {
    db.connect(cb);
  },
  db_bufs: ["db", function (cb, res) {
    db.client.query("SELECT fid, room_id FROM room_buffer WHERE deleted = FALSE;", [], cb);
  }],
  s3_bufs: ["db_bufs", function s3_get(cb, res, marker, contents) {
    marker = marker || 0;
    contents = contents || [];
    console.log("Marker:", marker, "contents:", contents.length);
    s3_client.list({ prefix: "", marker: marker }, function (err, data) {
      console.log("Got", _.keys(data.Contents).length, "buffers from s3");
      contents = contents.concat(data.Contents);
      if (data.IsTruncated) {
        return s3_get(cb, res, marker + data.MaxKeys, contents);
      }
      return cb(err, contents);
    });
  }],
  delete_s3: ["s3_bufs", function (cb, res) {
    var to_delete;

    to_delete = _.filter(res.s3_bufs, function (s3_buf) {
      var db_buf,
        fid,
        room_id;

      room_id = s3_buf.Key.split("/");
      fid = parseInt(room_id[1], 10);
      room_id = parseInt(room_id[0], 10);
      db_buf = _.find(res.db_bufs.rows, function (buf) {
        return buf.fid === fid && buf.room_id === room_id;
      });
      return _.isUndefined(db_buf);
    });

    to_delete = _.map(to_delete, function (s3_buf) {
      return s3_buf.Key;
    });
    console.log("Deleting", to_delete.length, "buffers from s3");

    async.eachLimit(to_delete, 6, function (buf_guid, cb) {
      console.log("Deleting buffer", buf_guid, "from s3.");
      s3_client.deleteFile(buf_guid, function (err, res) {
        if (err) {
          console.log("Error deleting buffer", buf_guid, "from s3:", err);
        } else {
          console.log("Deleted buffer", buf_guid, "from s3");
        }
        cb(err, res);
      });
    }, cb);
  }]
}, function (err) {
  console.log(err);
  process.exit();
});
