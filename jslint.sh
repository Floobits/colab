#!/bin/sh

jslint \
--plusplus \
--sloppy \
--todo \
--node \
--nomen \
--indent 2 \
lib/*.js scripts/*.js tests/*.js
