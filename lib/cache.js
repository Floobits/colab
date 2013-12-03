var util = require("util");

var log = require("floorine");
var _ = require("lodash");
var mc = require("mc");

var settings = require("./settings");


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
  client.disconnect();
  client = null;
};

var reconnect = function (cb) {
  disconnect();
  client = new mc.Client(settings.cache_servers, mc.Adapter.json);
  connect(cb);
};

var default_cb = function (action, key) {
  return function (err) {
    if (err) {
      if (err.type === 'CONNECTION_ERROR') {
        log.error("Memcached connection error. Reconnecting.");
        reconnect();
        return;
      }
      log.error(util.format("Cache error. %s key %s: %s", action, key, err));
      return;
    }
    log.debug(util.format("Successfully %s key %s", action, key));
  };
};

var del = function (key, cb) {
  cb = cb || default_cb("delete", key);
  client.del(key, cb);
};

var get = function (key, cb) {
  cb = cb || default_cb("get", key);
  log.debug(util.format("Getting key %s", key));
  client.get(key, cb);
};

var gets = function (key, cb) {
  cb = cb || default_cb("get", key);
  log.debug(util.format("CAS getting key %s", key));
  client.gets(key, cb);
};

var set = function (key, value, opts, cb) {
  opts = opts || {
    flags: 0,
    exptime: 0
  };
  cb = cb || default_cb("set", key);

  log.debug(util.format("Setting key %s to %s", key, value));
  client.set(key, value, opts, cb);
};

var cas = function (key, value, cas, opts, cb) {
  opts = opts || {
    flags: 0,
    exptime: 0
  };
  cb = cb || function (err, status) {
    if (err) {
      if (err.type === 'CONNECTION_ERROR') {
        log.error("Memcached connection error. Reconnecting.");
        reconnect();
        return;
      }
      try {
        err = JSON.stringify(err);
      } catch (ignore) {
      }
      log.error(util.format("Cache error. cas key %s: %s", key, err));
      return;
    }
    log.log(util.format("Successfully cas key %s status %s", key, status));
  };
  log.log(util.format("CAS Setting key %s (cas %s) to %s", key, cas, JSON.stringify(value)));
  client.cas(key, value, cas, opts, cb);
};

module.exports = {
  cas: cas,
  client: client,
  connect: connect,
  disconnect: disconnect,
  del: del,
  get: get,
  gets: gets,
  reconnect: reconnect,
  set: set
};