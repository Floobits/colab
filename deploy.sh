#!/bin/sh

if [ $# -eq 0 ]
then
  echo "Usage: $0 release-name.tar.gz hostname0 hostname1 hostname2 ..."
  exit 0
fi

echo $1 | grep '\.tar\.gz$'

if [ $? -eq 0 ]
then
  TARBALL=$1
  shift
else
  echo "Building tarball..."
  TARBALL=`./build_release.sh`
  echo "Built $TARBALL"
fi

RELEASE_NAME=$(basename "$TARBALL")
RELEASE_NAME="${RELEASE_NAME%%.*}"
RELEASE_DIR="/data/releases/$RELEASE_NAME"

for HOST in $@
do
  echo "Deploying $RELEASE_NAME to $HOST"

  scp -C $TARBALL $HOST:/tmp
  scp ./upgrade.sh $HOST:/tmp/upgrade_$RELEASE_NAME.sh

  ssh $HOST "sudo /tmp/upgrade_$RELEASE_NAME.sh /tmp/$TARBALL"

  if [ $? -eq 0 ]
  then
    curl -X POST http://$USER:$USER@dev00.floobits.com/deploy/colab/$HOST
  else
    echo "OMG DEPLOY FAILED"
  fi
done
