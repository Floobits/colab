var _ = require("lodash");
var mc = require("mc");

var log = require("./log");
var settings = require("./settings");


var client = new mc.Client(settings.cache_servers, mc.Adapter.json);

var connect = function (cb) {
  log.log("Connecting to memcached...")
  client.connect(function (err, result) {
    if (err) {
      log.error("Error connecting to memcached:", err);
    } else {
      log.log("Connected to memcached!");
    }
    cb(err, result);
  });
};

var get = function (key, value, cb) {
  client.get(key, cb);
};

var set = function (key, value, opts, cb) {
  client.set(key, value, opts, cb);
};

module.exports = {
  client: client,
  connect: connect,
  get: get,
  set: set
};
