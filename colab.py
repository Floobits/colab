
import Queue
import threading
import socket
import os
import select
import json
import collections

import sublime
import sublime_plugin
from lib import diff_match_patch as dmp

PATCH_Q = Queue.Queue()
BUF_STATE = collections.defaultdict(str)


def text(view):
    return view.substr(sublime.Region(0, view.size()))


def get_view(buf_uid):
    for window in sublime.windows():
        for view in window.views():
            if view.buffer_id() == buf_uid:
                return view
    return None


class DMP(object):
    def __init__(self, view):
        self.buffer_id = view.buffer_id()
        self.file_name = view.file_name()
        self.current = text(view)
        self.previous = BUF_STATE[self.buffer_id]

    def __str__(self):
        return "%s - %s" % (self.file_name, self.buffer_id)

    def patch(self):
        return dmp.diff_match_patch().patch_make(self.previous, self.current)

    def to_json(self):
        return json.dumps({
                'uid': str(self.buffer_id),
                'file_name': self.file_name,
                'patch': json.dumps([str(x).encode('base64') for x in self.patch()])
            })


class AgentConnection(object):
    """ Simple chat server using select """

    def __init__(self):
        self.sock = None
        self.buf = ""

    @staticmethod
    def put(item):
        PATCH_Q.put(item)
        qsize = PATCH_Q.qsize()
        if qsize > 0:
            print('%s items in q' % qsize)

    def reconnect(self):
        sublime.set_timeout(self.connect, 100)

    def connect(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.connect(('127.0.0.1', 12345))
        self.sock.setblocking(0)
        print('connected, calling select')
        self.select()

    def get_patches(self):
        while True:
            try:
                yield PATCH_Q.get_nowait()
            except Queue.Empty:
                break

    def protocol(self, req):
        self.buf += req
        if not self.buf:
            return
        patches = []
        while True:
            before, sep, after = self.buf.partition('\n')
            if not sep:
                break
            patches.append(before)
            self.buf = after
        if patches:
            Listener.apply_patches(patches)

    def select(self):
        if not self.sock:
            print('no sock')
            return

        # this blocks until the socket is readable or writeable
        _in, _out, _except = select.select([self.sock], [self.sock], [self.sock])

        if _except:
            print('socket error')
            self.sock.close()
            self.reconnect()
            return

        if _in:
            buf = ""
            try:
                while True:
                    d = self.sock.recv(4096)
                    if not d:
                        break
                    buf += d
            except Exception as e:
                print "exception", e
            self.protocol(buf)
            print "data", buf

        if _out:
            for patch in self.get_patches():
                p = patch.to_json()
                print('writing a patch', p)
                self.sock.sendall(p + '\n')
                PATCH_Q.task_done()

        sublime.set_timeout(self.select, 100)


class Listener(sublime_plugin.EventListener):
    views_changed = []
    url = 'http://fixtheco.de:3149/patch/'

    @staticmethod
    def push():
        reported = set()
        while Listener.views_changed:
            view = Listener.views_changed.pop()

            buf_id = view.buffer_id()
            if buf_id in reported:
                continue

            reported.add(buf_id)
            patch = DMP(view)
            #update the current copy of the buffer
            BUF_STATE[buf_id] = patch.current
            PATCH_Q.put(patch)

        sublime.set_timeout(Listener.push, 100)

    @staticmethod
    def apply_patches(self, patches):
        # dmp.patch_fromText(before)
        # t = dmp.patch_apply(patches, t)
        # #get text
        # t = text(view)
        # #apply patch to text
        # t = dmp.patch_apply(patches, t)
        pass

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
        self.add(view)

    def on_activated(self, view):
        if view.is_scratch():
            return
        self.add(view)
        print 'activated', self.name(view)

    def add(self, view):
        if view.is_scratch():
            print('is scratch')
            return
        self.views_changed.append(view)


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

Listener.push()


def run_agent():
    try:
        agent = AgentConnection()
        agent.connect()
    except Exception as e:
        print e

thread = threading.Thread(target=run_agent)
thread.start()
