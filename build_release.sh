#!/bin/sh

DATETIME=`date -u '+%Y_%m_%d_%H%M'`
RELEASE_NAME="colab-$DATETIME"

FILE_LIST=`git ls-files`

tar -c -z -f $RELEASE_NAME.tar.gz $FILE_LIST node_modules && \
echo "$RELEASE_NAME.tar.gz"
