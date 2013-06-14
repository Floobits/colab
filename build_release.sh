#!/bin/sh

DATETIME=`date -u '+%Y_%m_%d_%H%M'`
RELEASE_NAME="colab-$DATETIME"

echo "$RELEASE_NAME.tar.gz"

tar -c -z -f $RELEASE_NAME.tar.gz `git ls-files`
