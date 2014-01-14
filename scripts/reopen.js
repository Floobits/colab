var path = require("path");
var util = require("util");

var async = require("async");
var log = require("floorine");
var leveldown = require("leveldown");
var levelup = require("levelup");
var _ = require("lodash");

var db = require("db");
var settings = require("settings");
var utils = require("utils");

settings.server_db_dir = path.join(settings.base_dir, "server_db");
log.set_log_level(settings.log_level);

var i = 0;

var reopen = function (cb) {
  var auto = {};

  auto.open = function (cb) {
    var options = {
      cacheSize: 0,
      createIfMissing: true
    };
    return levelup(settings.server_db_dir, options, cb);
  };

  auto.close = ["open", function (cb, response) {
      var db = response.open;
      db.close(cb);
    }];

  async.auto(auto, function (err, result) {
    if (err) {
      log.error(err, result);
      process.exit(1);
    }
    i++;
    log.log("Reopened %s times", i);
    global.gc();
    return cb(err, result);
  });
};

async.whilst(function () {
  return i < 10000;
}, reopen, function () {
  log.log("Done.");
});
