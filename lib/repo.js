"use strict";

const child_process = require("child_process");
const path = require("path");
const url = require("url");
const util = require("util");

const async = require("async");
const fs = require("fs-extra");
const log = require("floorine");
const _ = require("lodash");

const settings = require("./settings");
const utils = require("./utils");

// TODO: svn will totally not work with branches besides trunk
const PULL_CMD = {
  git: "git --git-dir='%s/.git' pull --no-edit --no-tags origin %s",
  hg: "hg pull -u -R '%s' -r %s",
  svn: "svn update --trust-server-cert --non-interactive '%s/%s'",
};

const DEFAULT_BRANCH = {
  git: "master",
  hg: "default",
  svn: "trunk",
};

// TODO: svn will totally not work with branches besides trunk
const CLONE_BRANCH_ARG = {
  git: "--branch '%s'",
  hg: "-r '%s'",
  svn: "branches/%s",
};

const ALLOWED_PROTOCOLS = ["git:", "http:", "https:", "ssh:", "svn:", null];
const ALLOWED_TYPES = ["git", "hg", "svn"];
let CLONE_CMD;

const Repo = function (room, repo_info, private_github_url) {
  const self = this;

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
  if (!_.contains(ALLOWED_TYPES, self.type)) {
    throw new Error(util.format("Error creating repository: %s is not a valid repo type", self.type));
  }
  self.private_github_url = private_github_url;
  self.branch = repo_info.branch || DEFAULT_BRANCH[self.type];
  self.branch = self.normalize_branch(self.branch);
  if (!self.branch) {
    throw new Error("Invalid branch name.");
  }

  if (_.isUndefined(repo_info.url) || _.isUndefined(repo_info.type)) {
    throw new Error(util.format("Bad repo info from database: %s", JSON.stringify(repo_info)));
  }
  self.url = self.normalize_url(repo_info.url);
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
    data.private_github = true;
  }
  return data;
};

// This probably shouldn't be on the Repo class
Repo.prototype.normalize_branch = function (branch) {
  // Strip single quotes from branchname to prevent escaping attacks
  return branch.replace(/'/g, "");
};

Repo.prototype.normalize_url = function (u) {
  // Kill all single quotes so people can't do mean things with our exec call
  u = u.replace(/'/g, "");
  const url_obj = url.parse(u);
  if (!_.contains(ALLOWED_PROTOCOLS, url_obj.protocol)) {
    throw new Error(util.format("%s is not a valid protocol", url_obj.protocol));
  }
  return u;
};

// Only check type and URL. Different branch is equal
Repo.prototype.is_equal = function (req) {
  if (!req) {
    return false;
  }
  let u;
  try {
    u = this.normalize_url(req.url);
  } catch (unused) {
    return false;
  }
  return req.type === this.type && u === this.url;
};

Repo.prototype.clone = function (agent, req_id, clone_cb) {
  const self = this;
  const clone_url = self.private_github_url || self.url;

  if (self.path.indexOf(settings.repos_dir) !== 0) {
    log.error("A SUPER BAD THING ALMOST HAPPENED");
    return clone_cb(util.format("Error cloning %s: Somehow, something broke. Sorry.", clone_url));
  }
  let auto = {
    rm_dir: function (cb) {
      fs.remove(self.path, cb);
    },
    mk_dir: ["rm_dir", function (cb) {
      fs.mkdir(self.path, "0755", cb);
    }],
    clone: ["mk_dir", function (cb) {
      const branch_arg = util.format(CLONE_BRANCH_ARG[self.type], self.branch);
      const cmd = util.format("%s '%s' %s %s", CLONE_CMD[self.type], clone_url, branch_arg, self.path);
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
  const self = this;
  let cmd = util.format(PULL_CMD[self.type], self.path, self.branch);
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
  const self = this;
  let errs = [];
  let seen_paths = [];

  function handle_file(filename, callback) {
    const rel_path = path.relative(self.path, filename);
    const buf = self.room.get_buf_by_path(rel_path);

    fs.readFile(filename, function (err, buffer) {
      if (err) {
        setImmediate(function () { callback(err); });
        return;
      }
      seen_paths.push(rel_path);

      const encoding = utils.is_binary(buffer, buffer.length) ? "base64" : "utf8";
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
  const self = this;
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
