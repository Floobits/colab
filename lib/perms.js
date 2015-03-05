/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

var _ = require("lodash");


const db_perms_mapping = {
  "view_room": ["get_buf", "ping", "pong", "webrtc"],
  "request_perms": ["get_buf", "request_perms"],
  "edit_room": ["patch", "get_buf", "set_buf", "create_buf", "delete_buf", "rename_buf",
                "set_temp_data", "delete_temp_data",
                "highlight", "msg", "datamsg",
                "create_term", "term_stdin", "delete_term", "update_term", "term_stdout", "saved"],
  "admin_room": ["kick", "pull_repo", "perms", "solicit"]
  // TODO: maybe make solicit a little more restrictive?
};

function fine_grained_perms(perms_list) {
  var fgp = [];

  _.each(perms_list, function (perm) {
    fgp = fgp.concat(db_perms_mapping[perm]);
  });

  return _.uniq(fgp);
}

const all_perms = fine_grained_perms(_.keys(db_perms_mapping));


module.exports = {
  all_perms: all_perms,
  db_perms_mapping: db_perms_mapping,
  fine_grained_perms: fine_grained_perms
};
