/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var child_process = require("child_process");
var path = require("path");
var url = require("url");
var util = require("util");

var async = require("async");
var fs = require("fs-extra");
var log = require("floorine");
var _ = require("lodash");

var settings = require("./settings");
var utils = require("./utils");

var PULL_CMD = {
  "git": "git --git-dir='%s/.git' pull --no-edit --no-tags origin master",
  "hg": "hg pull -u -R '%s'",
  "svn": "svn update --trust-server-cert --non-interactive '%s'"
};

var ALLOWED_PROTOCOLS = ["git:", "http:", "https:", "ssh:", "svn:", null];
var ALLOWED_TYPES = ["git", "hg", "svn"];
var CLONE_CMD;

var Repo = function (room, repo_info) {
  var self = this,
    url_obj;

  // Super lame, but necessary since settings isn't populated until after this file is loaded.
  if (!CLONE_CMD) {
    CLONE_CMD = {
      "git": "git clone --depth 1 --recursive",
      "hg": "hg clone",
      "svn": "svn checkout --trust-server-cert --non-interactive"
    };

    if (settings.ssh_wrapper_path) {
      CLONE_CMD.git = util.format("GIT_SSH=%s %s", settings.ssh_wrapper_path, CLONE_CMD.git);
      PULL_CMD.git = util.format("GIT_SSH=%s %s", settings.ssh_wrapper_path, PULL_CMD.git);
    }
  }

  self.room = room;
  self.type = repo_info.type;
  // Kill all single quotes so people can't do mean things with our exec call
  self.url = repo_info.url.replace(/'/g, "");
  url_obj = url.parse(self.url);
  if (!_.contains(ALLOWED_PROTOCOLS, url_obj.protocol)) {
    throw new Error(util.format("Error creating repository: %s is not a valid protocol", url_obj.protocol));
  }
  if (!_.contains(ALLOWED_TYPES, self.type)) {
    throw new Error(util.format("Error creating repository: %s is not a valid repo type", self.type));
  }
  if (self.type === "git") {
    // Strip off the leading git://
    self.url = self.url.replace(/^git:\/\//, "");
  }
  self.path = path.normalize(path.join(settings.repos_dir, "room_" + room.id));
};

Repo.prototype.to_json = function () {
  var self = this;
  return {
    type: self.type,
    url: self.url
  };
};

Repo.prototype.clone = function (agent, req_id, cb) {
  var self = this,
    auto;

  if (self.path.indexOf(settings.repos_dir) !== 0) {
    log.error("A SUPER BAD THING ALMOST HAPPENED");
    return cb(util.format("Error cloning %s: Somehow, something broke. Sorry.", self.url));
  }
  auto = {
    rm_dir: function (cb) {
      fs.remove(self.path, cb);
    },
    mk_dir: ["rm_dir", function (cb) {
      fs.mkdir(self.path, "0755", cb);
    }],
    clone: ["mk_dir", function (cb) {
      var cmd = util.format("%s '%s' %s", CLONE_CMD[self.type], self.url, self.path);
      log.log("Cloning repo:", cmd);
      // TODO: create a terminal and show the output
      child_process.exec(cmd, cb);
    }]
  };
  return async.auto(auto, function (err) {
    if (err) {
      log.error(err);
      return cb(err);
    }
    return self.room_repo_pull(agent, req_id, cb);
  });
};

Repo.prototype.pull = function (agent, req_id, cb) {
  var self = this,
    cmd;
  cmd = util.format(PULL_CMD[self.type], self.path);
  log.log("Pulling repo:", cmd);
  // TODO: create a terminal and show the output
  child_process.exec(cmd, {cwd: self.path}, function (err, result) {
    if (err) {
      return cb(err, result);
    }
    return self.room_repo_pull(agent, req_id, cb);
  });
};

Repo.prototype.room_repo_pull = function (agent, req_id, cb) {
  var self = this,
    errs = [],
    seen_paths = [];

  utils.walk_dir(self.path, function (err, paths) {
    if (err) {
      log.error(err);
    }
    async.eachLimit(_.values(paths), 20, function (filename, callback) {
      var buf,
        rel_path;
      rel_path = path.relative(self.path, filename);
      buf = self.room.get_buf_by_path(rel_path);

      fs.readFile(filename, function (err, buffer) {
        var encoding;

        if (err) {
          setImmediate(function () { callback(err); });
          return;
        }
        encoding = utils.is_binary(buffer, buffer.length) ? 'base64' : 'utf8';
        seen_paths.push(rel_path);

        if (buf) {
          buf.set(agent, req_id, buffer, null, encoding, true, callback);
          return;
        }
        self.room.create_buf(agent, req_id, rel_path, buffer, encoding, function (err, result) {
          if (err) {
            log.error("failed creating buf", rel_path, ":", err, result);
            errs.push(rel_path);
          } else {
            log.debug("created buf", rel_path);
          }
          callback(null, result);
        });
      });
    }, function (err, result) {
      if (err) {
        return cb(err, result);
      }
      _.each(self.room.bufs, function (buf, buf_id) {
        if (!_.contains(seen_paths, buf.path)) {
          log.debug(buf.path, "isn't in seen paths. deleting");
          self.room.delete_buf(agent, req_id, buf_id, false, function () { return; });
        }
      });
      if (errs.length > 0) {
        err = util.format("Error pulling %s. Couldn't create bufs for paths: ", self.url);
        err += errs.join("\n");
        err += "\nBinary files and files larger than " + settings.max_buf_len + " bytes are not allowed.";
      }
      return cb(err, result);
    });
  });
};

Repo.prototype.update = function (agent, req_id, cb) {
  var self = this;

  log.debug("Updating workspace", self.room.toString());
  fs.exists(self.path, function (exists) {
    if (exists) {
      self.pull(agent, req_id, cb);
    } else {
      self.clone(agent, req_id, cb);
    }
  });
};

module.exports = Repo;
