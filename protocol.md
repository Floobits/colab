# Floobits colab protocol (working title)

## Transport
The protocol is new line, utf-8 separated JSON.


## Errors

Errors will sometimes disconnect.

error:
```
{
  "res_id": 1234,
  "status": "error",
  "message": "error message"
}
```

## Authentication

auth request:

```
{
  "action": "auth",
  "req_id": 1234,
  "api_key": api_key,
  "secret": auth_secret,
  "client": {
    "platform": platform,
    "name": client_name,
    "version": 1.0
  },
  "capabilities": ["base64", "webrtc", "chat"],
  "version": 1.0
}
```

response:
```
{
  "res_id": 1234
  "status": "success",
  "conn_id": 3
}
```


## Channels

{
  "action": "join",
  "channel": "Floobits/blah",
  "req_id": 10
}

{
  "res_id": 10,
  "status": "success",
  "type": "workspace",
  "users": {
    "120": {
      "username": "ggreer",
      "conn_id": 120,
      "client": {
        "platform": "Windows",
        "name": "Sublime Text 3",
        "version": 1.0
      },
      "capabilities": ["base64", "webrtc", "chat"],
      "version": 1.0
    }
  },
  "bufs": {
    
  },
  ""
}

{
  "action": "join",
  "channel": "ggreer",
  "req_id": 10
}

part


## Channel types

workspace
org
user


## Actions

```````````````````````````````````````````````````````````
|        |  buf | term | work | user | clie |  org | vide |
|   auth |      |      |      |      |      |      |      |
|   join |      |      |   x  |   x  |      |   x  |   x  |
|   part |      |      |   x  |   x  |      |   x  |   x  |
| create |   x  |   x  |      |      |      |      |      |
|    get |   x  |      |      |      |      |      |      |
|    set |   x  |      |      |      |      |      |      |
|    msg |      |      |   x  |   x  |      |   x  |      |
| delete |   x  |      |      |      |      |      |      |
|  patch |   x  |      |      |      |      |      |      |
|   kick |      |      |      |   x  |   x  |      |      |
| summon |   x  |      |      |      |      |      |      |
```````````````````````````````````````````````````````````


auth (special)
join
part
create
get
set
msg
delete
patch
kick
summon


## Nouns

buf
terminal
workspace
user
client
org
video


## Events

part
join
kick
create


## Request ids & responses

"req_id"
"res_id"

