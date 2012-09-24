import json
import Queue
import threading
import cStringIO
import socket

import sublime
import sublime_plugin
from lib import diff_match_patch as dmp


SOCK = socket.socket()
SOCK.connect(('127.0.0.1', 12345))
SOCK.setblocking(0)
Q = Queue.Queue()
BUF = ""
BUFS = {}


def text(view):
    return view.substr(sublime.Region(0, view.size()))


def get_view(buf_uid):
    for window in sublime.windows():
        for view in window.views():
            if view.buffer_id() == buf_uid:
                return view
    return None


def handle_req(line):
    req = json.loads(line)
    view = get_view(req.uid)
    if not view:
        print 'no view found for req: %s' % (req)
        return
    #get patch obj
    patches = []
    for patch in req.patches:
        patches.append(dmp.patch_fromText(patch))
    #get text
    t = text(view)
    #apply patch to text
    t = dmp.patch_apply(patches, t)
    #update buffer
    region = sublime.Region(0, view.size())
    view.replace(region, t)


def send_patches():
    reported = set()
    while (True):
        try:
            view = Q.get_nowait()
        except Queue.Empty:
            break
        buf_id = view.buffer_id()
        if buf_id in reported:
            continue
        t = text(view)
        patches = dmp.diff_match_patch().patch_make(BUFS[buf_id], t)
        print('sending report for %s' % (view.file_name()))

        BUFS[buf_id] = t

        patches = json.dumps([str(x).encode('base64') for x in patches])
        request = {
            "patches": patches,
            "uid": buf_id,
            "file_name": view.file_name()
        }
        req = json.dumps(request) + '\n'
        BUFS[buf_id] = t
        print req
        SOCK.send(req)


def recv_patches():
    global BUF
    while True:
        try:
            BUF += SOCK.recv(1024)
        except socket.error:
            break

    for line in BUF.split('\n'):
        if not line:
            return
        try:
            handle_req(line)
        except:
            raise
    new_buf = cStringIO.String()
    new_buf.write(BUF.read())
    BUF.close()
    BUF = new_buf


def sync():
    send_patches()
    recv_patches()
    sublime.set_timeout(sync, 200)


__active_linter_thread = threading.Thread(target=sync)
__active_linter_thread.start()


class Listener(sublime_plugin.EventListener):
    url = 'http://fixtheco.de:3149/patch/'

    def run(self):
        print('running')
        sublime.set_timeout(self.sync, 200)

    def id(self, view):
        return view.buffer_id()

    def name(self, view):
        return view.file_name()

    def on_new(self, view):
        print 'new', self.name(view)

    def on_load(self, view):
        #self.add_to_buf(view)
        print 'load', self.name(view)

    def on_clone(self, view):
        self.add(view)
        print 'clone', self.name(view)

    def on_activated(self, view):
        self.add(view, True)
        print 'activated', self.name(view)

    def add(self, view, no_stomp=False):
        print("adding %s" % (view.file_name()))
        buf_id = view.buffer_id()
        if no_stomp and buf_id in BUFS:
            return False
        BUFS[buf_id] = text(view)
        return True

    def on_modified(self, view):
        self.add(view, True)
        Q.put(view)
