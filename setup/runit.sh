#!/bin/bash

cp -r runit /etc/sv/colabcontroller

if [ ! -e /etc/service/colabcontroller ]
then
    echo "/etc/service/colabcontroller doesn't exist. Creating it..."
    ln -s /etc/sv/colabcontroller /etc/service/
fi

if [ ! -e /service ]
then
    echo "/service doesn't exist. Creating it..."
    ln -s /etc/service /service
fi

if [ ! -e /etc/service/colabcontroller/log/main ]
then
    echo "/etc/service/colabcontroller/log/main doesn't exist. Creating it..."
    mkdir /etc/sv/colabcontroller/log/main
    chown nobody:root /etc/sv/colabcontroller/log/main
fi
