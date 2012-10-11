
import Queue
import threading
import socket
import os
import select

import sublime
import sublime_plugin
from lib import diff_match_patch as dmp


def text(view):
    return view.substr(sublime.Region(0, view.size()))


def get_view(buf_uid):
    for window in sublime.windows():
        for view in window.views():
            if view.buffer_id() == buf_uid:
                return view
    return None


class DMP(object):
    def __init__(self, previous, view):
        self.current = text(view)
        self.previous = previous
        self.buffer_id = view.buffer_id()
        self.file_name = view.file_name()

    def __str__(self):
        return "%s - %s" % (self.file_name, self.buffer_id)


class AgentConnection(object):
    """ Simple chat server using select """
    Q = Queue.Queue()

    def __init__(self):
        self.sock = None
        self.buf = ""

    @staticmethod
    def add_to_queue(item):
        AgentConnection.Q.put(item)

    def connect(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        #self.sock.setblocking(0)
        self.sock.connect(('127.0.0.1', 12345))
        print(self.sock)
        self.select()

    def get_patches(self):
        while True:
            try:
                yield self.Q.get_nowait()
            except Queue.Empty:
                break

    def protocol(self, req):
        self.buf += req
        if not self.buf:
            return
        reqs = []
        while True:
            before, sep, after = self.buf.partition('\n')
            if not sep:
                break
            reqs.append(before)
            self.buf = after

    def select(self):
        if not self.sock:
            print('no sock')
            return
              # try:
        # this blocks until the socket is readable or writeable
        _in, _out, _except = select.select([self.sock], [self.sock], [self.sock])
        # except select.error as e:
        #     break
        # except socket.error as e:
        #     break
        if _except:
            print('socket error')
            self.sock.close()
            return

        if _in:
            print('reading socket')
            buf = self.sock.recv()
            if not buf:
                print('disconnect')
                self.sock.close()
            self.protocol(buf)

        if _out:
            print('writing socket')
            for patch in self.get_patches():
                print('writing a patch')
                self.sock.sendall(patch)

        sublime.set_timeout(self.select, 100)


class Listener(sublime_plugin.EventListener):
    Q = Queue.Queue()
    BUFS = {}
    url = 'http://fixtheco.de:3149/patch/'

    @staticmethod
    def push():
        reported = set()
        while True:
            try:
                view = Listener.Q.get_nowait()
            except Queue.Empty:
                break

            print('got view %s' % view)

            buf_id = view.buffer_id()
            if buf_id in reported:
                continue
            reported.add(buf_id)

            patch = DMP(Listener.BUFS[buf_id], view)
            AgentConnection.add_to_queue(patch)

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
        print("adding %s" % (view.file_name()))
        buf_id = view.buffer_id()
        if no_stomp and buf_id in self.BUFS:
            return False
        self.BUFS[buf_id] = text(view)
        self.Q.put(view)
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

sublime.set_timeout(Listener.push, 200)


def run_agent():
    try:
        agent = AgentConnection()
        agent.connect()
    except Exception as e:
        print e

thread = threading.Thread(target=run_agent)
thread.start()
