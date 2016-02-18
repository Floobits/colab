#!/bin/sh

DATETIME=$(date -u '+%Y_%m_%d_%H%M')
RELEASE_NAME="colab-$DATETIME"

FILE_LIST=$(git ls-files)

# shellcheck disable=SC2086
tar cvzhf "$RELEASE_NAME.tar.gz" $FILE_LIST node_modules && \
echo "$RELEASE_NAME.tar.gz"
