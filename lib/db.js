var pg = require("pg");

var log = require("./log");

var client = new pg.Client({
  user: "floobits",
  password: "",
  database: "floobits",
  host: "/var/run/postgresql"
});

client.connect();

module.exports = client;
