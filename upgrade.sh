#!/bin/bash

if [ $# -eq 0 ]
then
  echo "Usage: $0 release-name.tar.gz"
  exit 0
fi

TARBALL=$1
RELEASE_NAME=$(basename "$TARBALL")
RELEASE_NAME="${RELEASE_NAME%%.*}"
RELEASE_BASE="/data/releases"
RELEASE_DIR="$RELEASE_BASE/$RELEASE_NAME"

# Echo commands
set -x

# shellcheck disable=SC2010,SC2046
mkdir "$RELEASE_DIR" && \
tar xzf "$TARBALL" --directory "$RELEASE_DIR" && \
cd "$RELEASE_DIR" && \
HOME=/tmp npm rebuild --unsafe-perm --build-from-source heapdump && \
rm -fr /tmp/.node* && \
HOME=/tmp npm rebuild --unsafe-perm --build-from-source $(ls node_modules | grep -v heapdump) && \
cp /data/colab/lib/local_settings.js "$RELEASE_DIR/lib/local_settings.js" && \
ln -s -f "$RELEASE_DIR" /data/colab-new && \
mv -T -f /data/colab-new /data/colab && \
sv restart /service/colab && \
echo "Successfully updated to $RELEASE_NAME"

if [ $? -ne 0 ]
then
  echo "ERROR DEPLOYING! BAILING"
  exit 1
fi

# Remove all but the last 5 releases
# shellcheck disable=SC2010
OLD_RELEASES=$(ls -t -1 $RELEASE_BASE | grep -F "colab-" | sed -e '1,5d')
for OLD_RELEASE in $OLD_RELEASES
do
  echo "Removing old release: $RELEASE_BASE/$OLD_RELEASE"
  rm -fr "${RELEASE_BASE:?}/${OLD_RELEASE:?}"
done
