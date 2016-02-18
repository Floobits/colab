#!/bin/sh

if [ $# -eq 0 ]
then
  echo "Usage: $0 release-name.tar.gz hostname0 hostname1 hostname2 ..."
  exit 0
fi

DIR="$( cd "$( dirname "$0" )" && pwd )"
cd "$DIR" || (echo "cd $DIR failed!" && exit 1)

echo "$1" | grep '\.tar\.gz$'

if [ $? -eq 0 ]
then
  TARBALL=$1
  shift
else
  echo "Building tarball..."
  TARBALL="$(./build_release.sh | tail -n 1)"
  echo "$TARBALL" | grep '\.tar\.gz$'
  if [ $? -ne 0 ]
  then
    echo "ERROR BUILDING TARBALL!"
    exit 1
  fi
  echo "Built $TARBALL"
fi

RELEASE_NAME=$(basename "$TARBALL")
RELEASE_NAME="${RELEASE_NAME%%.*}"

for HOST in "$@"
do
  echo "Deploying $RELEASE_NAME to $HOST"

  scp -C "$TARBALL" "$HOST:/tmp"
  scp ./upgrade.sh "$HOST:/tmp/upgrade_$RELEASE_NAME.sh"

  SSH_CMD="sudo /tmp/upgrade_$RELEASE_NAME.sh /tmp/$TARBALL"
  # shellcheck disable=SC2029
  ssh "$HOST" "$SSH_CMD"

  if [ $? -eq 0 ]
  then
    curl -X POST "https://$USER:$USER@dev00.floobits.com/deploy/colab/$HOST" &
  else
    echo "OMG DEPLOY FAILED"
  fi
done
