import sublime, sublime_plugin
from lib import diff_match_patch as dmp 

class Listener(sublime_plugin.EventListener):
	def __init__(self, *args, **kwargs):
		sublime_plugin.EventListener.__init__(self, *args, **kwargs)
		self.dirty = False
		self.t = ""
		self.sel = None
		self.patch = dmp.diff_match_patch().patch_make
		
	def on_new(self, view):
		print view

	def on_load(self, view):
		self.t = self.text(view)
		print view

	def on_modified(self, view):
		self.dirty = True
		# print 'dirty'
		# self.t = self.text(view)
		print self.patch(self.text(view), self.text(self.view))
		self.view = view

	def text(self, view):
		return view.substr(sublime.Region(0, view.size())).encode('utf-8')

	def on_selection_modified(self, view):
		sel = view.sel()[0]

		# if not self.dirty:
		# 	self.sel = sel 
		# 	return
		
		# self.dirty = False
		
		# if self.sel is None:
		# 	self.sel = sel

		# region = (self.sel.begin(), sel.end())
		# self.sel = sel
		# print region
		# print region, view.substr(sublime.Region(*region))
		#print view.substr(sublime.Region(sel.begin()-1, sel.end()))
		
		# region = view.visible_region()abcde
		# text = view.substr(region)
		#lastLine = view.rowcol(sel[0].end())[0]