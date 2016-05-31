"use strict";

const async = require("async");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const basicAuth = require("basic-auth");
const log = require("floorine");
const _ = require("lodash");


// Finds URLs in random text
const url_regex = new RegExp("(?:https?:\\/\\/)?[-a-zA-Z0-9@:%._\\+~#=]{2,256}\\.[a-z]{2,4}(?::[0-9]{1-5})?\\b([-a-zA-Z0-9@:%_\\+.,~#?&//=]*)", "gi");

function md5(text) {
  return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

function patched_cleanly(result) {
  let clean_patch = true;
  for (let i = 0; i < result[1].length; i++) {
    if (result[1][i] !== true) {
      clean_patch = false;
      break;
    }
  }
  return clean_patch;
}

function squelch(cb) {
  return function (err, res) {
    if (err) {
      log.debug(err);
    }
    return cb(null, res);
  };
}

function tree_add_buf(tree, buf_path, buf_id) {
  let chunks = buf_path.split("/");
  const file_name = chunks.slice(-1)[0];
  let sub_tree = tree;

  // GOOD INTERVIEW QUESTION
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (i === chunks.length - 1 && sub_tree[chunk] !== undefined) {
      log.warn("trying to stomp path", buf_path);
      return null;
    }
    sub_tree = sub_tree[chunk];
    if (sub_tree === undefined) {
      break;
    }
  }

  sub_tree = tree;
  _.each(chunks, function (c, pos) {
    if (!sub_tree[c]) {
      sub_tree[c] = {};
    }
    if (pos < chunks.length - 1) {
      sub_tree = sub_tree[c];
    }
  });
  sub_tree[file_name] = buf_id;

  return sub_tree;
}

function walk_dir(p, cb) {
  let paths = [];

  function on_readdir(readdir_err, filenames) {
    if (readdir_err) {
      return cb(readdir_err, paths);
    }
    async.each(filenames,
      function (file, callback) {
        const abs_path = path.join(p, file);
        walk_dir(abs_path, function (err, sub_paths) {
          paths = paths.concat(sub_paths);
          callback(err);
        });
      },
      function (err) {
        cb(err, paths);
      });
  }

  fs.lstat(p, function (stat_err, st) {
    if (stat_err) {
      log.warn("Couldn't stat %s: %s", p, stat_err);
      return cb(null, paths);
    }
    // Ignore hidden files. Yeah I know this is lame and you can put hidden files in a repo/room.
    if (_.includes([".svn", ".git", ".hg"], path.basename(p))) {
      return cb(null, paths);
    }
    if (st.isFile()) {
      paths.push(p);
      return cb(null, paths);
    }
    if (st.isDirectory()) {
      return fs.readdir(p, on_readdir);
    }
    log.warn("walk_dir: %s is not directory or file", p);
    // Don't append to paths. Just keep on truckin'
    return cb(null, paths);
  });
}

function is_binary(bytes, size) {
  if (size === 0) {
    return false;
  }

  if (size >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    // UTF-8 BOM. This isn't binary.
    return false;
  }

  // Only scan up to first 512 bytes
  const total_bytes = Math.min(size, 512);
  let suspicious_bytes = 0;
  for (let i = 0; i < total_bytes; i++) {
    if (bytes[i] === 0) { // NULL byte--it's binary!
      return true;
    }
    if ((bytes[i] < 7 || bytes[i] > 14) && (bytes[i] < 32 || bytes[i] > 127)) {
      // UTF-8 detection
      if (bytes[i] > 191 && bytes[i] < 224 && i + 1 < total_bytes) {
        i++;
        if (bytes[i] < 192) {
          continue;
        }
      } else if (bytes[i] > 223 && bytes[i] < 239 && i + 2 < total_bytes) {
        i++;
        if (bytes[i] < 192 && bytes[i + 1] < 192) {
          i++;
          continue;
        }
      }
      suspicious_bytes++;
      // Read at least 32 bytes before making a decision
      if (i > 32 && (suspicious_bytes * 100) / total_bytes > 10) {
        return true;
      }
    }
  }

  if ((suspicious_bytes * 100) / total_bytes > 10) {
    return true;
  }

  return false;
}

function set_state(o, state) {
  if (o.state < state) {
    o.state = state;
  } else {
    log.warn("%s tried to go from %s to %s", o.toString(), o.state, state);
  }
  // TODO: emit state change event or whatever
}

function basic_auth(name, pass) {
  return function (req, res, next) {
    const auth = basicAuth(req);
    if (!auth || auth.name !== name || auth.pass !== pass) {
      return res.send(401);
    }
    return next();
  };
}

const limits = {};

function rate_limit(id, timeout, f) {
  if (limits[id]) {
    // TODO: check value of last_call and queue up timeout
    return;
  }
  limits[id] = Date.now();
  f();
  setTimeout(function () {
    delete limits[id];
  }, timeout);
}

module.exports = {
  basic_auth,
  is_binary,
  md5,
  patched_cleanly,
  rate_limit,
  set_state,
  squelch,
  tree_add_buf,
  url_regex,
  walk_dir,
};
