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


var Repo = function (room, repo_info) {
  var self = this;

  self.allowed_types = ["git", "hg", "svn"];
  self.clone_cmd = {
    "git": "git clone",
    "hg": "hg clone",
    "svn": "svn checkout"
  };
  self.pull_cmd = {
    "git": "git --git-dir=%s/.git pull",
    "hg": "hg pull -u -R %s",
    "svn": "svn update %s"
  };

  self.room = room;
  self.type = repo_info.type;
  self.url = repo_info.url;
  self.path = path.normalize(path.join(settings.repo_dir, "room_" + room.id));

  if (!_.contains(self.allowed_types, self.type)) {
    throw new Exception(util.format("%s is not a valid repo type", self.type));
  }
};

Repo.prototype.clone = function (cb) {
  var self = this;
  cb = cb || function () {};
  if (self.path.indexOf(settings.repo_dir) !== 0) {
    log.error("A SUPER BAD THING ALMOST HAPPENED");
    return cb("Somehow, something broke. Sorry.");
  }
  // XXXXX: seriously, rm -fr? this is just begging to be exploited
  return child_process.exec(util.format("rm -fr %s", self.path), function (err, result) {
    var cmd = util.format("%s %s %s", self.clone_cmd[self.type], self.url, self.path);
    log.debug("Cloning repo:", cmd);
    child_process.exec(cmd, function (err, result) {
      self.room_repo_pull(cb);
    });
  });
};

Repo.prototype.pull = function (cb) {
  var self = this,
      cmd;
  cb = cb || function () {};
  cmd = util.format(self.pull_cmd[self.type], self.path);
  log.debug("Pulling repo:", cmd);
  child_process.exec(cmd, function (err, result) {
    self.room_repo_pull(cb);
  });
};

Repo.prototype.room_repo_pull = function (cb) {
  var self = this,
      cmd,
      paths,
      seen_paths = [];

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

    if (buf) {
      self.room.delete_buf(buf.id, create_buf);
    } else {
      create_buf();
    }
    seen_paths.push(rel_path);
  }, function (err, result) {
    if (err) {
      return cb(err, result);
    }
    _.each(self.room.bufs, function (buf, buf_id) {
      if (!_.contains(seen_paths, buf.path)) {
        self.room.delete_buf(buf_id, function () {});
      }
    });
    return cb(err, result);
  });
};

Repo.prototype.update = function (cb) {
  var self = this;

  log.debug("Updating room", self.room.toString());
  if (fs.existsSync(self.path)) {
    self.pull(cb);
  } else {
    fs.mkdirSync(self.path);
    self.clone(cb);
  }
};

module.exports = Repo;
