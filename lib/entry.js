/*jslint indent: 2, node: true, nomen: true, plusplus: true, todo: true */
"use strict";

process.on("uncaughtException", function (err) {
  console.error("Error:");
  console.error(err);
  console.error("Stack:");
  console.error(err.stack);
  throw new Error(err);
});

exports.run = function run() {
  require("./server").run();
};
