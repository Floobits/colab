#!/bin/sh

jslint \
--plusplus true \
--sloppy true \
--todo true \
--node true \
--indent 2 \
--nomen true \
lib/*.js lib/master/*.js tests/*.js
