"""View GTK3 da barra — Linux/GNOME.

So desenha e traduz teclas: toda a decisao esta em vmbar_core.BarCore.
"""

import os
import threading

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gio, GLib, Gtk  # noqa: E402

import vmplatform  # noqa: E402
from vmbar_core import ADDED, ERROR, OPEN, BarCore  # noqa: E402
from vmclient import ApiError, Client  # noqa: E402

APP_ID = "dev.vaultmarks.Bar"
WIDTH = 680
# Com 1, a barra nao se esconde ao perder o foco (util pra depurar e pra print).
NO_AUTOHIDE = os.environ.get("VAULTMARKS_NO_AUTOHIDE") == "1"

CSS = b"""
window.vm { background: transparent; }
.vm-box {
  background: @theme_bg_color;
  border: 1px solid alpha(@theme_fg_color, 0.18);
  border-radius: 14px;
  box-shadow: 0 12px 40px alpha(black, 0.45);
}
.vm-entry {
  font-size: 19px;
  padding: 14px 16px;
  background: transparent;
  border: 0;
  box-shadow: none;
  caret-color: @theme_selected_bg_color;
}
.vm-sep { background: alpha(@theme_fg_color, 0.12); min-height: 1px; }
.vm-row { padding: 8px 16px; }
.vm-title { font-size: 14px; }
.vm-url { font-size: 11.5px; opacity: 0.6; }
.vm-badge {
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 10px;
  background: alpha(@theme_selected_bg_color, 0.20);
}
.vm-badge.cat { background: alpha(#f0b86e, 0.22); }
.vm-badge.folder { background: alpha(#7ee0a1, 0.22); }
.vm-status { font-size: 11px; opacity: 0.55; padding: 6px 16px; }
.vm-error { color: #ff6b6b; font-size: 12px; padding: 4px 16px; }
"""


class Bar(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.client = Client()
        self.core = BarCore(self.client)
        self.window = None
        self.ignore_focus_out = False
        self.add_main_option("daemon", 0, GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
                             "Inicia residente e escondido", None)

    # ---------------- ciclo de vida ----------------
    def do_command_line(self, command_line):
        daemon = "--daemon" in command_line.get_arguments()
        if daemon:
            self.ensure_window()
            self.sync_async()
        else:
            self.activate()
        return 0

    def do_activate(self):
        self.ensure_window()
        self.show_bar()

    def ensure_window(self):
        if self.window:
            return
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        self.build_window()

    def build_window(self):
        win = Gtk.ApplicationWindow(application=self)
        win.get_style_context().add_class("vm")
        win.set_decorated(False)
        win.set_skip_taskbar_hint(True)
        win.set_skip_pager_hint(True)
        win.set_keep_above(True)
        win.set_type_hint(Gdk.WindowTypeHint.DIALOG)
        win.set_default_size(WIDTH, -1)
        win.set_resizable(False)
        win.set_app_paintable(True)
        visual = win.get_screen().get_rgba_visual()
        if visual:
            win.set_visual(visual)

        win.connect("focus-out-event", self.on_focus_out)
        win.connect("delete-event", lambda *_: self.hide_bar() or True)
        win.connect("key-press-event", self.on_key)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        box.get_style_context().add_class("vm-box")

        self.entry = Gtk.Entry()
        self.entry.get_style_context().add_class("vm-entry")
        self.entry.set_has_frame(False)
        self.entry.set_placeholder_text("search…   #tag  @category  /folder   ·   + url to add")
        self.entry.connect("changed", lambda *_: self.on_query_changed())
        self.entry.connect("activate", lambda *_: self.run_selected())
        box.pack_start(self.entry, False, False, 0)

        sep = Gtk.Box()
        sep.get_style_context().add_class("vm-sep")
        box.pack_start(sep, False, False, 0)

        self.listbox = Gtk.ListBox()
        self.listbox.set_selection_mode(Gtk.SelectionMode.BROWSE)
        self.listbox.connect("row-activated", lambda _lb, row: self.run_selected(row.get_index()))
        self.listbox.connect("row-selected", self.on_row_selected)

        self.scroll = Gtk.ScrolledWindow()
        self.scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.scroll.set_max_content_height(430)
        self.scroll.set_propagate_natural_height(True)
        self.scroll.add(self.listbox)
        box.pack_start(self.scroll, True, True, 0)

        self.status = Gtk.Label(xalign=0)
        self.status.get_style_context().add_class("vm-status")
        box.pack_start(self.status, False, False, 0)

        win.add(box)
        self.window = win

    def place_on_active_monitor(self):
        """Centraliza no monitor do cursor, a ~22% do topo.

        Com varios monitores, WindowPosition.CENTER cairia na emenda entre eles.
        """
        screen = self.window.get_screen()
        display = screen.get_display()
        pointer = display.get_default_seat().get_pointer()
        _, px, py = pointer.get_position()[0:3] if hasattr(pointer, "get_position") else (None, 0, 0)
        monitor = display.get_monitor_at_point(px, py) or display.get_primary_monitor()
        area = monitor.get_workarea()

        height = self.window.get_preferred_height()[1] or 120
        x = area.x + (area.width - WIDTH) // 2
        y = area.y + int(area.height * 0.22)
        self.window.move(x, min(y, area.y + area.height - height - 20))

    def show_bar(self):
        if self.needs_login():
            return
        self.entry.set_text("")
        self.core.set_query("")
        self.render()
        self.window.show_all()
        self.place_on_active_monitor()
        self.window.present_with_time(Gdk.CURRENT_TIME)
        self.entry.grab_focus()
        # Ignora o focus-out espurio que o WM dispara enquanto a janela sobe.
        self.ignore_focus_out = True
        GLib.timeout_add(400, self.arm_focus_out)
        self.sync_async()

    def arm_focus_out(self):
        self.ignore_focus_out = False
        return False

    def on_focus_out(self, *_):
        if not self.ignore_focus_out and not NO_AUTOHIDE:
            self.hide_bar()
        return False

    def hide_bar(self):
        if self.window:
            self.window.hide()
        return False

    # ---------------- login ----------------
    def needs_login(self):
        # O YAML de config manda: com token valido ou usuario/senha ali, a barra
        # entra sozinha na mesma conta que a web usa, sem dialogo nenhum.
        try:
            if self.client.ensure_session():
                return False
        except ApiError:
            pass
        self.show_login_dialog()
        return True

    def show_login_dialog(self):
        dlg = Gtk.Dialog(title="Vaultmarks — sign in", modal=True)
        dlg.set_default_size(360, -1)
        dlg.add_buttons("Cancel", Gtk.ResponseType.CANCEL, "Sign in", Gtk.ResponseType.OK)
        dlg.set_default_response(Gtk.ResponseType.OK)

        grid = Gtk.Grid(row_spacing=8, column_spacing=8, margin=16)
        server = Gtk.Entry(text=self.client.config["server"], hexpand=True)
        login = Gtk.Entry(placeholder_text="username or email", hexpand=True, activates_default=True)
        password = Gtk.Entry(placeholder_text="password", visibility=False, hexpand=True, activates_default=True)
        error = Gtk.Label()
        error.get_style_context().add_class("vm-error")

        for i, (label, widget) in enumerate((("Server", server), ("Username", login), ("Password", password))):
            grid.attach(Gtk.Label(label=label, xalign=1), 0, i, 1, 1)
            grid.attach(widget, 1, i, 1, 1)
        grid.attach(error, 0, 3, 2, 1)
        dlg.get_content_area().add(grid)
        dlg.show_all()

        while dlg.run() == Gtk.ResponseType.OK:
            self.client.config["server"] = server.get_text().strip() or self.client.config["server"]
            try:
                self.client.login(login.get_text().strip(), password.get_text())
                dlg.destroy()
                self.client.sync()
                self.core.refresh()
                self.show_bar()
                return
            except ApiError as err:
                error.set_text(str(err))
        dlg.destroy()

    # ---------------- render ----------------
    def on_query_changed(self):
        self.core.set_query(self.entry.get_text())
        self.render()

    def render(self):
        for child in self.listbox.get_children():
            self.listbox.remove(child)
        for row in self.core.rows:
            self.listbox.add(self.build_row(row))
        self.status.set_text(self.core.status())
        self.listbox.show_all()
        first = self.listbox.get_row_at_index(self.core.sel)
        if first:
            self.listbox.select_row(first)

    def badge(self, kind, text):
        lbl = Gtk.Label(label=text)
        ctx = lbl.get_style_context()
        ctx.add_class("vm-badge")
        if kind in ("cat", "folder"):
            ctx.add_class(kind)
        return lbl

    def build_row(self, row):
        gtk_row = Gtk.ListBoxRow()
        gtk_row.get_style_context().add_class("vm-row")
        line = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)

        text = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        title = Gtk.Label(label=row.title, xalign=0, ellipsize=3)
        title.get_style_context().add_class("vm-title")
        subtitle = Gtk.Label(label=row.subtitle, xalign=0, ellipsize=3)
        subtitle.get_style_context().add_class("vm-url")
        text.pack_start(title, False, False, 0)
        text.pack_start(subtitle, False, False, 0)
        line.pack_start(text, True, True, 0)

        if row.badges:
            meta = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
            for kind, label in row.badges:
                meta.pack_start(self.badge(kind, label), False, False, 0)
            line.pack_end(meta, False, False, 0)

        gtk_row.add(line)
        return gtk_row

    def on_row_selected(self, _listbox, row):
        if row:
            self.core.select(row.get_index())

    # ---------------- acoes ----------------
    def run_selected(self, index=None):
        action, payload = self.core.activate(index)
        if action == OPEN:
            vmplatform.open_url(payload)
            self.hide_bar()
        elif action == ADDED:
            self.entry.set_text("")
            self.render()
            self.sync_async()
        elif action == ERROR:
            self.status.set_text(payload)

    def copy_selected(self):
        url = self.core.copy_selected()
        if url:
            Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(url, -1)
        self.status.set_text(self.core.status())

    def delete_selected(self):
        if self.core.delete_selected():
            self.render()
            self.sync_async()

    def move(self, delta):
        self.core.move(delta)
        row = self.listbox.get_row_at_index(self.core.sel)
        if row:
            self.listbox.select_row(row)
            row.grab_focus()
        self.entry.grab_focus_without_selecting()

    def on_key(self, _widget, event):
        key = Gdk.keyval_name(event.keyval)
        ctrl = event.state & Gdk.ModifierType.CONTROL_MASK

        if key == "Escape":
            if self.entry.get_text():
                self.entry.set_text("")
            else:
                self.hide_bar()
            return True
        if key in ("Down", "Tab") or (ctrl and key == "n"):
            self.move(1)
            return True
        if key in ("Up", "ISO_Left_Tab") or (ctrl and key == "p"):
            self.move(-1)
            return True
        if ctrl and key == "c":
            self.copy_selected()
            return True
        if ctrl and key == "d":
            self.delete_selected()
            return True
        if ctrl and key == "r":
            self.sync_async()
            return True
        return False

    # ---------------- sync ----------------
    def sync_async(self):
        if not self.client.authenticated:
            return

        def work():
            try:
                # Conexao SQLite propria: sqlite3 nao e thread-safe entre threads.
                applied = Client().sync()
                GLib.idle_add(self.on_synced, applied, None)
            except ApiError as err:
                GLib.idle_add(self.on_synced, 0, str(err))

        threading.Thread(target=work, daemon=True).start()

    def on_synced(self, applied, error):
        if self.core.on_sync_result(applied, error):
            if error:
                self.status.set_text(self.core.status())
            else:
                self.render()
        return False


def run(argv):
    return Bar().run(argv)
