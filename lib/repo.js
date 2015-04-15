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

var Repo = function (room, repo_info, private_github_url) {
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
  self.private_github_url = private_github_url;

  if (_.isUndefined(repo_info.url) || _.isUndefined(repo_info.type)) {
    throw new Error(util.format("Bad repo info from database: %s", JSON.stringify(repo_info)));
  }
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
  let data = {
    type: this.type,
    url: this.url
  };
  if (this.private_github_url) {
    data.private_github_url = this.private_github_url;
  }
  return data;
};

Repo.prototype.clone = function (agent, req_id, clone_cb) {
  var self = this,
    clone_url = self.private_github_url || self.url,
    auto;
  if (self.path.indexOf(settings.repos_dir) !== 0) {
    log.error("A SUPER BAD THING ALMOST HAPPENED");
    return clone_cb(util.format("Error cloning %s: Somehow, something broke. Sorry.", clone_url));
  }
  auto = {
    rm_dir: function (cb) {
      fs.remove(self.path, cb);
    },
    mk_dir: ["rm_dir", function (cb) {
      fs.mkdir(self.path, "0755", cb);
    }],
    clone: ["mk_dir", function (cb) {
      var cmd = util.format("%s '%s' %s", CLONE_CMD[self.type], clone_url, self.path);
      log.log("Cloning repo:", cmd);
      // TODO: create a terminal and show the output
      child_process.exec(cmd, cb);
    }]
  };
  return async.auto(auto, function (err) {
    if (err) {
      log.error(err);
      return clone_cb(err.toString());
    }
    return self.room_repo_pull(agent, req_id, clone_cb);
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
      return cb(err.toString(), result);
    }
    return self.room_repo_pull(agent, req_id, cb);
  });
};

Repo.prototype.room_repo_pull = function (agent, req_id, cb) {
  var self = this,
    errs = [],
    seen_paths = [];

  function handle_file(filename, callback) {
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
      encoding = utils.is_binary(buffer, buffer.length) ? "base64" : "utf8";
      seen_paths.push(rel_path);

      if (buf) {
        buf.set(agent, req_id, buffer, null, encoding, true, callback);
        return;
      }
      self.room.create_buf(agent, req_id, rel_path, buffer, encoding, function (create_err, result) {
        if (create_err) {
          log.error("failed creating buf", rel_path, ":", create_err, result);
          errs.push(rel_path);
        } else {
          log.debug("created buf", rel_path);
        }
        callback(null, result);
      });
    });
  }

  utils.walk_dir(self.path, function (walk_err, paths) {
    if (walk_err) {
      log.error(walk_err);
    }
    async.eachLimit(_.values(paths), 20, handle_file, function (err, result) {
      if (err) {
        return cb(err, result);
      }
      _.each(self.room.bufs, function (buf, buf_id) {
        if (!_.contains(seen_paths, buf.path)) {
          log.debug(buf.path, "isn't in seen paths. deleting");
          self.room.delete_buf(agent, req_id, buf_id, false);
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
