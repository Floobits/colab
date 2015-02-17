/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var util = require("util");

var log = require("floorine");
var _ = require("lodash");

var settings = require("./settings");
var utils = require("./utils");


var db_perms_mapping = {
  "view_room": ["get_buf", "ping", "pong", "webrtc"],
  "request_perms": ["get_buf", "request_perms"],
  "edit_room": ["patch", "get_buf", "set_buf", "create_buf", "delete_buf", "rename_buf",
                "set_temp_data", "delete_temp_data",
                "highlight", "msg", "datamsg",
                "create_term", "term_stdin", "delete_term", "update_term", "term_stdout", "saved"],
  "admin_room": ["kick", "pull_repo", "perms", "solicit"]
  // TODO: maybe make solicit a little more restrictive?
};

var all_perms = _.uniq(_.values(db_perms_mapping));

var fine_grained_perms = function (perms_list) {
  var fgp = [];

  _.each(perms_list, function (perm) {
    fgp = fgp.concat(db_perms_mapping[perm]);
  });

  return _.uniq(fgp);
};


module.exports = {
  all_perms: all_perms,
  db_perms_mapping: db_perms_mapping,
  fine_grained_perms: fine_grained_perms
};
