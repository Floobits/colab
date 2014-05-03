/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var child_process = require("child_process");
var fs = require("fs");
var path = require("path");
var url = require("url");
var util = require("util");

var async = require("async");
var log = require("floorine");
var _ = require("lodash");

var settings = require("./settings");
var utils = require("./utils");


var Repo = function (room, repo_info) {
  var self = this,
    url_obj;

  self.allowed_protocols = ["git:", "http:", "https:", "ssh:", "svn:"];
  self.allowed_types = ["git", "hg", "svn"];
  self.clone_cmd = {
    "git": "git clone --depth 1",
    "hg": "hg clone --insecure",
    "svn": "svn checkout --trust-server-cert --non-interactive"
  };
  self.pull_cmd = {
    "git": "git --git-dir='%s/.git' pull --no-edit",
    "hg": "hg pull -u --insecure -R '%s'",
    "svn": "svn update --trust-server-cert --non-interactive '%s'"
  };

  self.room = room;
  self.type = repo_info.type;
  // Kill all single quotes so people can't do mean things with our exec call
  self.url = repo_info.url.replace(/'/g, "");
  url_obj = url.parse(self.url);
  if (!_.contains(self.allowed_protocols, url_obj.protocol)) {
    throw new Error(util.format("Error creating repository: %s is not a valid protocol", url_obj.protocol));
  }
  self.path = path.normalize(path.join(settings.repos_dir, "room_" + room.id));

  if (!_.contains(self.allowed_types, self.type)) {
    throw new Error(util.format("Error creating repository: %s is not a valid repo type", self.type));
  }
};

Repo.prototype.to_json = function () {
  var self = this;
  return {
    type: self.type,
    url: self.url
  };
};

Repo.prototype.clone = function (req_id, agent, cb) {
  var self = this,
    auto;

  if (self.path.indexOf(settings.repos_dir) !== 0) {
    log.error("A SUPER BAD THING ALMOST HAPPENED");
    return cb(util.format("Error cloning %s: Somehow, something broke. Sorry.", self.url));
  }
  auto = {
    // TODO: use rimraf or fs-extra
    rm_dir: function (cb) {
      // XXXXX: seriously, rm -fr? this is just begging to be exploited
      child_process.exec(util.format("rm -fr %s", self.path), cb);
    },
    mk_dir: ["rm_dir", function (cb) {
      fs.mkdir(self.path, "0755", cb);
    }],
    clone: ["mk_dir", function (cb) {
      var cmd = util.format("%s '%s' %s", self.clone_cmd[self.type], self.url, self.path);
      log.debug("Cloning repo:", cmd);
      // TODO: create a terminal and show the output
      child_process.exec(cmd, cb);
    }]
  };
  return async.auto(auto, function (err) {
    if (err) {
      log.error(err);
      return cb(err);
    }
    return self.room_repo_pull(req_id, agent, cb);
  });
};

Repo.prototype.pull = function (req_id, agent, cb) {
  var self = this,
    cmd;
  cmd = util.format(self.pull_cmd[self.type], self.path);
  log.debug("Pulling repo:", cmd);
  // TODO: create a terminal and show the output
  child_process.exec(cmd, {cwd: self.path}, function (err, result) {
    if (err) {
      return cb(err, result);
    }
    self.room_repo_pull(req_id, agent, cb);
  });
};

Repo.prototype.room_repo_pull = function (req_id, agent, cb) {
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
          buf.set(req_id, agent, buffer, null, encoding, true, callback);
          return;
        }
        self.room.create_buf(rel_path, buffer, encoding, agent, req_id, function (err, result) {
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
          self.room.delete_buf(buf_id, agent, false, function () { return; });
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

Repo.prototype.update = function (req_id, agent, cb) {
  var self = this;

  log.debug("Updating workspace", self.room.toString());
  fs.exists(self.path, function (exists) {
    if (exists) {
      self.pull(req_id, agent, cb);
    } else {
      self.clone(req_id, agent, cb);
    }
  });
};

module.exports = Repo;
