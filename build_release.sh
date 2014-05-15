#!/bin/sh

DATETIME=`date -u '+%Y_%m_%d_%H%M'`
RELEASE_NAME="colab-$DATETIME.tar.gz"

echo "$RELEASE_NAME"

tar -c -z -f $RELEASE_NAME `git ls-files`

ln -sf $RELEASE_NAME colab-current.tar.gz

docker build -t colab-$DATETIME .
