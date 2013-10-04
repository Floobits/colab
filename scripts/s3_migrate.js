var util = require("util");

var s3 = require("./s3");

var async = require("async");
var log = require("floorine");

var db = require("./db");

var upload = function (buffer, cb) {
  var guid = util.format("%s-%s", buffer.room_id, buffer.fid);
  console.log(guid);

  var s3_client = s3.get_client();

  var req = s3_client.put(guid, {
    "Content-Length": buffer.cur_state.length,
    "Content-Type": "text/plain"
  });

  req.on("response", function (res) {
    if (res.statusCode === 200) {
      log.log("uproaded " + guid);
      return cb();
    }
    log.error("error saving buf", guid, "to s3");
    return cb(" status code: " + res.statusCode + " " + guid + " " + buffer.cur_state.length + " " + buffer.cur_state);
  });

  req.on("error", function (err) {
    console.dir(err);
    return cb(err);
  });

  req.end(buffer.cur_state);
};

async.auto({
  db: function (cb) {
    db.connect(cb);
  },
  buffers: ["db", function (cb, res) {
    db.client.query("SELECT fid, room_id, cur_state FROM room_buffer;", [],cb);
  }],
  upload: ["buffers", function (cb, res) {
    console.log(res.buffers.rows.length);
    async.eachLimit(res.buffer1.rows, 1, upload, cb);
  }]
}, function (err) {
  console.log(toString(err), "bye");
});
