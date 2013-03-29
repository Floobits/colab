var child_process = require("child_process");
var fs = require("fs");
var path = require("path");
var util = require("util");

var async = require("async");
var git = require("nodegit");
var _ = require("underscore");

var log = require("./log");
var settings = require("./settings");
var utils = require("./utils");


var Repo = function (room, url) {
  var self = this;
  self.room = room;
  self.url = url;
  self.path = path.normalize(path.join(settings.repo_dir, "room_" + room.id));
};

Repo.prototype.clone = function (cb) {
  var self = this,
      cmd;
  cb = cb || function () {};
  cmd = util.format("git clone %s %s", self.url, self.path);
  log.debug("Cloning repo:", cmd);
  child_process.exec(cmd, cb);
};

Repo.prototype.pull = function (cb) {
  var self = this,
      cmd;
  cb = cb || function () {};
  cmd = util.format("git --git-dir=%s/.git pull", self.path);
  log.debug("Pulling repo:", cmd);
  child_process.exec(cmd, cb);
};

Repo.prototype.stomp_over_room = function (cb) {
  var self = this,
      cmd,
      paths;

  paths = utils.walk_dir(self.path);
  async.each(_.values(paths), function (filename, callback) {
    var buf,
        rel_path,
        text;
    rel_path = path.relative(self.path, filename);
    buf = self.room.get_buf_by_path(rel_path);
    // TODO: don't use sync method here
    text = fs.readFileSync(filename, {encoding: "utf8"});

    function create_buf () {
      self.room.create_buf(rel_path, text, function (err, result) {
        if (err) {
          log.debug("failed creating buf", rel_path, ":", err, result);
        } else {
          log.debug("created buf", rel_path);
        }
        callback(err, result);
      });
    }

    // TODO: delete bufs that don't exist in repo anymore
    if (buf) {
      self.room.delete_buf(buf.id, create_buf);
    } else {
      create_buf();
    }
  }, cb);
};

Repo.prototype.update = function (cb) {
  var self = this;

  log.debug("Updating room", self.room);
  if (fs.existsSync(self.path)) {
    self.pull(self.stomp_over_room(cb));
  } else {
    fs.mkdirSync(self.path);
    self.clone(self.stomp_over_room(cb));
  }
};

module.exports = Repo;
