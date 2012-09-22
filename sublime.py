import sublime_plugin
import sublime
from lib import diff_match_patch as dmp

bufs = {}

import json


class Listener(sublime_plugin.EventListener):
    def id(self, view):
        return view.buffer_id()

    def name(self, view):
        return view.file_name()

    def on_new(self, view):
        print 'new', self.name(view)

    def on_load(self, view):
        self.add_to_buf(view)
        print 'load', self.name(view)

    def on_clone(self, view):
        self.add_to_buf(view)
        print 'clone', self.name(view)

    def on_activated(self, view):
        print 'activated', self.name(view)

    def add_to_buf(self, view):
        bufs[self.id(view)] = self.text(view)

    def text(self, view):
        return view.substr(sublime.Region(0, view.size()))

    def on_modified(self, view):
        _id = self.id(view)
        if not _id in bufs:
            self.add_to_buf(view)
            return
        t = self.text(view)
        patches = dmp.diff_match_patch().patch_make(bufs[_id], t)
        js = json.dumps([str(x) for x in patches])
        print js
        bufs[_id] = t
