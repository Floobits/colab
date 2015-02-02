/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var log = require("floorine");
var _ = require("lodash");
var mc = require("mc");

var settings = require("../settings");


var client = new mc.Client(settings.cache_servers, mc.Adapter.json);

var connect = function (cb) {
  if (!client) {
    client = new mc.Client(settings.cache_servers, mc.Adapter.json);
  }
  log.log("Connecting to memcached...");
  client.connect(function (err, result) {
    if (err) {
      log.error("Error connecting to memcached:", err);
    } else {
      log.log("Connected to memcached!");
    }
    if (cb) {
      cb(err, result);
    }
  });
};

var disconnect = function () {
  if (!client) {
    log.log("Already disconnected from memcached.");
    return;
  }
  log.log("Disconnecting from memcached...");
  try {
    client.disconnect();
  } catch (ignore) {}
  client = null;
};

var reconnect = function (cb) {
  log.log("Reconnecting to memcached...");
  disconnect();
  client = new mc.Client(settings.cache_servers, mc.Adapter.json);
  connect(cb);
};

var default_cb = function (action, key) {
  return function (err, status) {
    if (err) {
      if (err.type === "CONNECTION_ERROR") {
        log.error("Memcached connection error. Status: %s. Err: %s", status, err.description);
        reconnect();
        return;
      }
      try {
        err = JSON.stringify(err);
      } catch (ignore) {
      }
      log.error("Cache error. Status %s. %s key %s: %s", status, action, key, err);
      return;
    }
  };
};

var del = function (key, cb) {
  cb = cb || default_cb("delete", key);
  client.del(key, cb);
};

var get = function (key, cb) {
  cb = cb || default_cb("get", key);
  client.get(key, cb);
};

var gets = function (key, cb) {
  cb = cb || default_cb("gets", key);
  client.gets(key, cb);
};

var set = function (key, value, opts, cb) {
  opts = opts || {
    flags: 0,
    exptime: 0
  };
  cb = cb || default_cb("set", key);

  try {
    value = JSON.stringify(value);
  } catch (ignore) {
  }

  client.set(key, value, opts, cb);
};

var cas = function (key, value, cas, opts, cb) {
  opts = opts || {
    flags: 0,
    exptime: 0
  };
  cb = cb || default_cb("cas", key);

  try {
    value = JSON.stringify(value);
  } catch (ignore) {
  }

  log.debug("CAS Setting key %s (cas %s) to %s", key, cas, value);
  client.cas(key, value, cas, opts, cb);
};

var cas_set = function (key, update_cb) {
  gets(key, function (err, result) {
    if (err) {
      log.error(err);
      set(key, update_cb(null));
      return;
    }
    log.debug("result:", JSON.stringify(result));
    result[key].val = update_cb(result[key].val);
    if (_.isUndefined(result[key].cas)) {
      log.error("No cas for %s", key);
      set(key, result[key].val);
      return;
    }
    cas(key, result[key].val, result[key].cas);
  });
};


module.exports = {
  cas: cas,
  cas_set: cas_set,
  client: client,
  connect: connect,
  disconnect: disconnect,
  del: del,
  get: get,
  gets: gets,
  reconnect: reconnect,
  set: set
};
