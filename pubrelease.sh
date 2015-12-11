#!/bin/bash

if [ $# -eq 0 ]
then
  echo "Usage: $0 release-name.tar.gz hostname0 hostname1 hostname2 ..."
  exit 0
fi

DIR="$( cd "$( dirname "$0" )" && pwd )"
cd $DIR

echo $1 | grep '\.tar\.gz$'

if [ $? -eq 0 ]
then
  TARBALL=$1
  shift
else
  echo "Building tarball..."
  TARBALL="$(./build_release.sh | tail -n 1)"
  echo $TARBALL | grep '\.tar\.gz$'
  if [ $? -ne 0 ]
  then
    echo "ERROR BUILDING TARBALL!"
    exit 1
  fi
  echo "Built $TARBALL"
fi

RELEASE_NAME=$(basename "$TARBALL")
RELEASE_NAME="${RELEASE_NAME%%.*}"
RELEASE_DIR="/data/pubreleases/colab/"

for HOST in $@
do
  echo "Deploying $RELEASE_NAME to $HOST"

  scp -C $TARBALL $HOST:/tmp
  scp ./upgrade.sh $HOST:/tmp/upgrade_$RELEASE_NAME.sh

  ssh $HOST "sudo mkdir -p $RELEASE_DIR && \
  sudo cp /tmp/upgrade_$RELEASE_NAME.sh $RELEASE_DIR && \
  sudo cp /tmp/$TARBALL $RELEASE_DIR && \
  echo '$RELEASE_NAME' | sudo tee $RELEASE_DIR/latest"

  if [ $? -eq 0 ]
  then
    curl -X POST https://$USER:$USER@dev00.floobits.com/deploy/colab_pubrelease/$HOST
  else
    echo "OMG DEPLOY FAILED"
    exit 1
  fi
done
