var child_process = require("child_process");
var path = require("path");
var util = require("util");

var git = require("nodegit");

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
      paths;

  paths = utils.walk_dir(self.path);
  
};

Repo.prototype.update = function (cb) {
  var self = this;

  log.debug("Updating room", self.room);
  if (path.exists(self.path)) {
    self.pull(self.stomp_over_room(cb));
  } else {
    self.clone(self.stomp_over_room(cb));
  }
};
