#!/bin/bash

cp -r runit /etc/sv/colabcontrol

if [ ! -e /etc/service/colabcontrol ]
then
    echo "/etc/service/colabcontrol doesn't exist. Creating it..."
    ln -s /etc/sv/colabcontrol /etc/service/
fi

if [ ! -e /service ]
then
    echo "/service doesn't exist. Creating it..."
    ln -s /etc/service /service
fi

if [ ! -e /etc/service/colabcontrol/log/main ]
then
    echo "/etc/service/colabcontrol/log/main doesn't exist. Creating it..."
    mkdir /etc/sv/colabcontrol/log/main
    chown nobody:root /etc/sv/colabcontrol/log/main
fi
