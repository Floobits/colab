var util = require("util");

var async = require("async");

var db = require("./db");
var s3 = require("./s3");
var s3_client = s3.get_client();


function delete_buf (buf, cb) {
  var guid = util.format("%s-%s", buf.room_id, buf.fid);
  s3_client.deleteFile(guid, function (err, res) {
    if (err) {
      console.log("Error deleting buffer", buf.guid, "from s3:", err);
    } else {
      console.log("Deleted buffer", guid, "from s3");
    }
    cb(err, res);
  });
}

async.auto({
  db: function (cb) {
    db.connect(cb);
  },
  buffers: ["db", function (cb, res) {
    db.client.query("SELECT fid, room_id FROM room_buffer WHERE deleted = TRUE;", [], cb);
  }],
  delete_s3: ["buffers", function (cb, res) {
    console.log("Deleting", res.buffers.rows.length, "buffers");
    async.eachLimit(res.buffers.rows, 4, delete_buf, cb);
  }],
  delete_db: ["delete_s3", function (cb, res) {
    db.client.query("DELETE FROM room_buffer WHERE deleted = TRUE;", [], cb);
  }]
}, function (err) {
  console.log(err);
  process.exit();
});
