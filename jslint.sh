#!/bin/sh

jslint \
--plusplus \
--sloppy \
--todo \
--node \
--nomen \
--white \
lib/*.js tests/*.js
