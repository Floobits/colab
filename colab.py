
import json
import Queue
import threading
import time
import socket
import asyncore

import sublime
import sublime_plugin
from lib import diff_match_patch as dmp

Q = Queue.Queue()
BUF = ""
BUFS = {}
SOCK = None
previous = time.time()


def text(view):
    return view.substr(sublime.Region(0, view.size()))


def get_view(buf_uid):
    for window in sublime.windows():
        for view in window.views():
            if view.buffer_id() == buf_uid:
                return view
    return None


def run():
    conn = Conn()
    sublime.set_timeout(conn.send_patches, 3000)
    asyncore.loop()

__active_linter_thread = threading.Thread(target=run)
__active_linter_thread.start()


class Conn(asyncore.dispatcher):

    def __init__(self):
        asyncore.dispatcher.__init__(self)
        self.create_socket(socket.AF_INET, socket.SOCK_STREAM)
        self.connect(('127.0.0.1', 12345))
        self.buffer_out = ""
        self.buffer_in = ""

    def handle_connect(self):
        pass

    def handle_close(self):
        self.close()

    def handle_read(self):
        self.buffer_in += self.recv(1024)
        print (self.buffer_in)

    def writable(self):
        return (len(self.buffer_out) > 0)

    def handle_write(self):
        sent = self.send(self.buffer_out)
        self.buffer_out = self.buffer_out[sent:]

    def handle_req(self, line):
        print 'got request ' % (line)
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

    def send_patches(self):
        reported = set()
        while (True):
            print 'in send patches'
            try:
                print 'getting from queue'
                view = Q.get_nowait()
            except Queue.Empty:
                break
            buf_id = view.buffer_id()
            if buf_id in reported:
                continue
            reported.add(buf_id)
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
            self.buffer_out += request

    def recv_patches(self):
        for line in self.buffer_in.split('\n'):
            if not line:
                return
            self.handle_req(line)


class Listener(sublime_plugin.EventListener):
    url = 'http://fixtheco.de:3149/patch/'

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
        if view.is_scratch():
            return
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
        if view.is_scratch():
            return
        self.add(view, True)
        Q.put(view)
