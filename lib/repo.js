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

const EXEC_OPTS = {
  maxBuffer: 1000 * 1024,
  timeout: settings.repo_timeout,
};

const PULL_CMD = {
  git: "git --git-dir='%s/.git' pull --no-edit --no-tags origin %s",
  hg: "hg pull -u -R '%s' -r %s",
  svn: "svn update --trust-server-cert --non-interactive '%s'",
};

const DEFAULT_BRANCH = {
  git: "master",
  hg: "default",
  svn: "trunk",
};

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
  const data = {
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

function connect_term (agent, term, cp) {
  // Hack to send term stuff to user who initiated pull/clone
  term.broadcast = true;
  // Summon ppl to the term
  term.stdin(agent, null, "", true);
  cp.stdout.on("data", function (data) {
    data = new Buffer(data).toString("base64");
    term.stdout(null, data);
  });
  cp.stderr.on("data", function (data) {
    data = new Buffer(data).toString("base64");
    term.stdout(null, data);
  });
}

Repo.prototype.clone = function (agent, req_id, clone_cb) {
  const self = this;
  const clone_url = self.private_github_url || self.url;

  if (self.path.indexOf(settings.repos_dir) !== 0) {
    log.error("A SUPER BAD THING ALMOST HAPPENED");
    return clone_cb(util.format("Error cloning %s: Somehow, something broke. Sorry.", clone_url));
  }
  const auto = {
    rm_dir: function (cb) {
      fs.remove(self.path, cb);
    },
    mk_dir: ["rm_dir", function (cb) {
      fs.mkdir(self.path, "0755", cb);
    }],
    term: ["rm_dir", function (cb) {
      self.room.create_term(agent, util.format("clone_%s_%s", self.branch, self.room.cur_term_id), null, null, utils.squelch(cb));
    }],
    clone: ["mk_dir", "term", function (cb, res) {
      let branch_arg = util.format(CLONE_BRANCH_ARG[self.type], self.branch);
      let cmd;
      if (self.type === "svn") {
        if (self.branch === DEFAULT_BRANCH[self.type]) {
          branch_arg = self.branch;
        }
        cmd = util.format("%s '%s/%s' %s", CLONE_CMD[self.type], clone_url, branch_arg, self.path);
      } else {
        cmd = util.format("%s '%s' %s %s", CLONE_CMD[self.type], clone_url, branch_arg, self.path);
      }
      log.log("Cloning repo:", cmd);
      const cp = child_process.exec(cmd, EXEC_OPTS, cb);
      if (!res.term) {
        return;
      }
      connect_term(agent, res.term, cp);
      res.term.stdout(null, new Buffer(util.format("   *** CLONING %s ***\r\n", self.url)).toString("base64"));
    }]
  };
  return async.auto(auto, function (err, res) {
    if (res.term) {
      self.room.delete_term(agent, null, res.term.id);
    }
    if (err) {
      log.error(err);
      return clone_cb(err.toString());
    }
    return self.room_repo_pull(agent, req_id, clone_cb);
  });
};

Repo.prototype.pull = function (agent, req_id, pull_cb) {
  const self = this;
  let cmd;
  if (self.type === "svn") {
    cmd = util.format(PULL_CMD[self.type], self.path);
  } else {
    cmd = util.format(PULL_CMD[self.type], self.path, self.branch);
  }
  log.log("Pulling repo:", cmd);
  const opts = _.defaults({cwd: self.path}, EXEC_OPTS);

  const auto = {
    term: function (cb) {
      self.room.create_term(agent, util.format("pull_%s_%s", self.branch, self.room.cur_term_id), null, null, utils.squelch(cb));
    },
    pull: function (cb, res) {
      const cp = child_process.exec(cmd, opts, cb);
      if (!res.term) {
        return;
      }
      connect_term(agent, res.term, cp);
      res.term.stdout(null, new Buffer(util.format("   *** PULLING %s ***\r\n", self.url)).toString("base64"));
    }
  };
  return async.auto(auto, function (err, res) {
    if (res.term) {
      self.room.delete_term(agent, null, res.term.id);
    }
    if (err) {
      log.error(err);
      return pull_cb(err.toString());
    }
    return self.room_repo_pull(agent, req_id, pull_cb);
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
