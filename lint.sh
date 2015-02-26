#!/bin/sh

./node_modules/eslint/bin/eslint.js \
lib/*.js \
lib/handler/*.js \
lib/master/*.js \
lib/slave/*.js \
tests/*.js
