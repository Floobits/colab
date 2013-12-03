var util = require("util");

var log = require("floorine");
var _ = require("lodash");
var mc = require("mc");

var settings = require("./settings");


var client = new mc.Client(settings.cache_servers, mc.Adapter.json);

var connect = function (cb) {
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

var default_cb = function (action, key) {
  return function (err) {
    if (err) {
      if (err.type === 'CONNECTION_ERROR') {
        log.error("Memcached connection error. Reconnecting.");
        client = new mc.Client(settings.cache_servers, mc.Adapter.json);
        connect();
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
        client = new mc.Client(settings.cache_servers, mc.Adapter.json);
        connect();
        return;
      }
      log.error(util.format("Cache error. cas key %s: %s", key, err));
      return;
    }
    log.log(util.format("Successfully cas key %s status %s", key, status));
  };
  log.log(util.format("CAS Setting key %s (cas %s) to %s", key, cas, value));
  client.cas(key, value, cas, opts, cb);
};

module.exports = {
  cas: cas,
  client: client,
  connect: connect,
  del: del,
  get: get,
  gets: gets,
  set: set
};
