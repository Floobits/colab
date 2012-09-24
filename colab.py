import json
import Queue
import threading
import cStringIO

import sublime
import sublime_plugin
from lib import diff_match_patch as dmp

import socket


class Listener(sublime_plugin.EventListener, threading.Thread):
    bufs = {}
    url = 'http://fixtheco.de:3149/patch/'
    patcher = dmp.diff_match_patch().patch_make

    def __init__(self):
        super(Listener, self).__init__()
        self.sock = socket.socket()
        self.sock.setblocking(0)
        self.sock.connect(('localhost', 12345))
        self.queue = Queue.Queue()
        self.start()
        self.buf = cStringIO.String()

    def run(self):
        sublime.set_timeout(self.sync, 200)

    def sync(self):
        self.send_patches()
        self.recv_patches()
        sublime.set_timeout(self.sync, 200)

    def recv_patches(self):
        while True:
            try:
                socket.recvfrom_into(1024, self.buf)
            except socket.error:
                break
        self.buf.seek(0)
        for line in self.buf.readlines():
            try:
                self.handle_req(line)
            except:
                raise
        new_buf = cStringIO.String()
        new_buf.write(self.buf.read())
        self.buf.close()
        self.buf = new_buf

    def handle_req(self, line):
        req = json.loads(line)
        print req

    def send_patches(self):
        reported = set()
        while (True):
            try:
                view = self.queue.get_nowait()
            except Queue.Empty:
                break
            buf_id = self.id(view)
            if buf_id in reported:
                continue
            t = self.text(view)
            patches = self.patcher(self.bufs[buf_id], t)
            print('sending report for %s' % (view.file_name()))

            self.bufs[buf_id] = t

            patches = json.dumps([str(x).encode('base64') for x in patches])
            request = {
                "patches": patches,
                "uid": buf_id,
                "file_name": view.file_name()
            }
            self.bufs[self.id(view)] = self.text(view)
            reported.add(buf_id)
            req = json.dumps(request) + '\n'
            print req
            self.sock.send(req)

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
        buf_id = self.id(view)
        if no_stomp and buf_id in self.bufs:
            return False
        self.bufs[self.id(view)] = self.text(view)
        return True

    def text(self, view):
        return view.substr(sublime.Region(0, view.size()))

    def on_modified(self, view):
        self.add(view, True)
        self.queue.put(view)
