
import json
import Queue
import threading
import time
import socket
import os
import sys

import sublime
import sublime_plugin
from lib import diff_match_patch as dmp

from twisted.internet import protocol, reactor
from twisted.protocols import basic

Q = Queue.Queue()
BUF = ""
BUFS = {}
SOCK = None
previous = time.time()
active = True


def text(view):
    return view.substr(sublime.Region(0, view.size()))


def get_view(buf_uid):
    for window in sublime.windows():
        for view in window.views():
            if view.buffer_id() == buf_uid:
                return view
    return None


class Conn(basic.LineReceiver):

    def __init__(self):
        self.buffer_out = ""
        self.buffer_in = ""

    def connectionMade(self):
        print("CONNECTION MADE")
        self.send_patches()

    def lineReceived(self, line):
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
            try:
                text = Q.get(True, 1)
            except Queue.Empty:
                print "queue is empty"
                break
            print('got %s from q' % view)
            patches = dmp.diff_match_patch().patch_make(BUFS[buf_id], text)

            BUFS[buf_id] = text

            patches = json.dumps([str(x).encode('base64') for x in patches])
            request = {
                "patches": patches,
                "uid": 1,
                "file_name": "blah/blah/blah"
            }
            req = json.dumps(request)
            print req
            self.sendLine(req)
        print "scheduling send patches"
        sublime.set_timeout(self.send_patches, 200)

    def recv_patches(self):
        for line in self.buffer_in.split('\n'):
            if not line:
                return
            self.handle_req(line)


class ConnFactory(protocol.ClientFactory):
    protocol = Conn
    def doStart(self):
            pass

    def startedConnecting(self, connectorInstance):
        print connectorInstance

    def buildProtocol(self, address):
        print address
        return self.protocol()

    def clientConnectionLost(self, connection, reason):
        print reason
        print connection

    def clientConnectionFailed(self, connection, reason):
        print connection
        print reason

    def doStop(self):
        pass

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

    def on_modified(self, view):
        self.add(view, True)

    def on_activated(self, view):
        if view.is_scratch():
            return
        self.add(view, True)
        print 'activated', self.name(view)

    def add(self, view, no_stomp=False):
        if view.is_scratch():
            return
#        if not active:
#            return
        print("adding %s" % (view.file_name()))
        buf_id = view.buffer_id()
        if no_stomp and buf_id in BUFS:
            return False
        BUFS[buf_id] = text(view)
        Q.put(text(view))
        return True


class JoinChannelCommand(sublime_plugin.TextCommand):
    def run(self, *args, **kwargs):
        self.get_window().show_input_panel("Channel", "", self.on_input, None, None)
        #self.panel('hawro')

    def on_input(self, channel):
        print('chanel: %s' % channel)
        sublime.status_message('colab chanel: %s' % (channel))

    def active_view(self):
        return self.view

    def is_enabled(self):
        return True

    def get_file_name(self):
        return os.path.basename(self.view.file_name())

    def get_working_dir(self):
        return os.path.dirname(self.view.file_name())

    def get_window(self):
        # Fun discovery: if you switch tabs while a command is working,
        # self.view.window() is None. (Admittedly this is a consequence
        # of my deciding to do async command processing... but, hey,
        # got to live with that now.)
        # I did try tracking the window used at the start of the command
        # and using it instead of view.window() later, but that results
        # panels on a non-visible window, which is especially useless in
        # the case of the quick panel.
        # So, this is not necessarily ideal, but it does work.
        return self.view.window() or sublime.active_window()

    def _output_to_view(self, output_file, output, clear=False, syntax="Packages/JavaScript/JavaScript.tmLanguage"):
        output_file.set_syntax_file(syntax)
        edit = output_file.begin_edit()
        if clear:
            region = sublime.Region(0, self.output_view.size())
            output_file.erase(edit, region)
        output_file.insert(edit, 0, output)
        output_file.end_edit(edit)


    def scratch(self, output, title=False, **kwargs):
        scratch_file = self.get_window().new_file()
        if title:
            scratch_file.set_name(title)
        scratch_file.set_scratch(True)
        self._output_to_view(scratch_file, output, **kwargs)
        scratch_file.set_read_only(True)
        return scratch_file

    def panel(self, output, **kwargs):
        if not hasattr(self, 'output_view'):
            self.output_view = self.get_window().get_output_panel("git")
        self.output_view.set_read_only(False)
        self._output_to_view(self.output_view, output, clear=True, **kwargs)
        self.output_view.set_read_only(True)
        self.get_window().run_command("show_panel", {"panel": "output.git"})

    def quick_panel(self, *args, **kwargs):
        self.get_window().show_quick_panel(*args, **kwargs)


def unrun():
    global active
    active = False
    print('bailing')
    reactor.stop()


def iterate():
    reactor.iterate()
    sublime.set_timeout(iterate, 50)

def run():
    try:
        conn = Conn()
        reactor.connectTCP('127.0.0.1', 12345, ConnFactory())
        iterate()
#        reactor.run()
    except Exception as e:
        print e

run()
#thread = threading.Thread(target=run)
#thread.start()
