"""Tkinter view of the bar, for macOS (and as a fallback on Linux without GTK).

Tk comes with Python, so macOS needs no dependency at all. As with GTK, all the
logic lives in vmbar_core.BarCore; this file only has drawing, keyboard handling
and the macOS window tricks.

macOS does not let an arbitrary process register a global shortcut, so what
opens the bar is the launcher (Shortcuts.app / skhd / Raycast) running this
script again: the second instance only sends "show" over the socket and exits.
See vmipc.py.
"""

import os
import threading
import tkinter as tk
from tkinter import font as tkfont

import vmipc
import vmplatform
from vmbar_core import ADDED, ERROR, OPEN, BarCore
from vmclient import ApiError, Client

WIDTH = 680
ROW_HEIGHT = 46
MAX_VISIBLE = 9
# With 1, the bar does not hide when it loses focus (handy for debugging and screenshots).
NO_AUTOHIDE = os.environ.get("VAULTMARKS_NO_AUTOHIDE") == "1"

# Fixed dark palette: Tk has no system theme like GTK, and the bar shows up on
# top of anything, so predictable contrast is better.
BG = "#1e1f24"
BG_SEL = "#2f3540"
FG = "#e8e9ed"
FG_DIM = "#9aa0aa"
ACCENT = "#7aa2f7"
BADGE = {"tag": "#3b4252", "cat": "#5a4632", "folder": "#2f4a3a"}
BORDER = "#3a3d45"


class Bar:
    def __init__(self, daemon=False):
        self.client = Client()
        self.core = BarCore(self.client, max_results=MAX_VISIBLE + 3)
        self.visible = False
        self.listener = None

        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title("Vaultmarks")
        self._build()

        if not daemon:
            self.show()

    # ---------------- construction ----------------
    def _build(self):
        self.root.configure(bg=BG)
        # No title bar: this is a spotlight bar, not a window.
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)

        base = tkfont.nametofont("TkDefaultFont").actual("family")
        self.f_entry = tkfont.Font(family=base, size=17)
        self.f_title = tkfont.Font(family=base, size=13)
        self.f_sub = tkfont.Font(family=base, size=10)
        self.f_badge = tkfont.Font(family=base, size=9)
        self.f_status = tkfont.Font(family=base, size=10)

        frame = tk.Frame(self.root, bg=BG, highlightthickness=1,
                         highlightbackground=BORDER, highlightcolor=BORDER)
        frame.pack(fill="both", expand=True)

        self.var = tk.StringVar()
        self.entry = tk.Entry(
            frame, textvariable=self.var, font=self.f_entry, bg=BG, fg=FG,
            insertbackground=ACCENT, relief="flat", highlightthickness=0, borderwidth=0)
        self.entry.pack(fill="x", padx=16, pady=14)
        self.var.trace_add("write", lambda *_: self.on_query_changed())

        tk.Frame(frame, bg=BORDER, height=1).pack(fill="x")

        self.list = tk.Frame(frame, bg=BG)
        self.list.pack(fill="both", expand=True)

        self.status = tk.Label(frame, text="", font=self.f_status, bg=BG, fg=FG_DIM,
                               anchor="w", padx=16, pady=6)
        self.status.pack(fill="x")

        for seq in ("<Escape>", "<Down>", "<Up>", "<Tab>", "<Shift-Tab>", "<Return>",
                    "<Control-n>", "<Control-p>", "<Control-c>", "<Control-d>", "<Control-r>",
                    "<Command-c>", "<Command-d>", "<Command-r>", "<Command-w>"):
            self.root.bind(seq, self.on_key)

        self.root.bind("<FocusOut>", self.on_focus_out)

    # ---------------- window ----------------
    def place(self):
        """Centres horizontally, about 22% from the top of the screen."""
        self.root.update_idletasks()
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        h = max(self.root.winfo_reqheight(), 120)
        x = (sw - WIDTH) // 2
        y = int(sh * 0.22)
        self.root.geometry(f"{WIDTH}x{h}+{x}+{y}")

    def show(self):
        if not self.client.authenticated:
            # The config YAML rules: with a valid token, or username/password in
            # it, the bar signs in by itself to the same account the web uses.
            try:
                self.client.ensure_session()
            except ApiError:
                pass
        if not self.client.authenticated:
            self.ask_login()
            if not self.client.authenticated:
                return

        self.var.set("")
        self.core.set_query("")
        self.render()
        self.root.deiconify()
        self.place()
        self.root.lift()
        self.root.attributes("-topmost", True)
        # On macOS an overrideredirect window does not take focus by itself.
        self.root.focus_force()
        self.entry.focus_set()
        self.visible = True
        self.sync_async()

    def hide(self):
        self.visible = False
        self.root.withdraw()

    def on_focus_out(self, _event=None):
        if self.visible and not NO_AUTOHIDE:
            self.hide()

    # ---------------- login ----------------
    def ask_login(self):
        dlg = tk.Toplevel(self.root, bg=BG)
        dlg.title("Vaultmarks: sign in")
        dlg.attributes("-topmost", True)
        dlg.geometry("380x210")

        server = tk.StringVar(value=self.client.config["server"])
        user = tk.StringVar()
        pwd = tk.StringVar()
        error = tk.Label(dlg, text="", fg="#ff6b6b", bg=BG, font=self.f_sub, wraplength=340)

        for i, (label, var, secret) in enumerate((("Server", server, False),
                                                  ("Username", user, False),
                                                  ("Password", pwd, True))):
            tk.Label(dlg, text=label, bg=BG, fg=FG, font=self.f_sub).grid(
                row=i, column=0, sticky="e", padx=10, pady=8)
            entry = tk.Entry(dlg, textvariable=var, bg=BG_SEL, fg=FG, relief="flat",
                             insertbackground=ACCENT, show="•" if secret else "")
            entry.grid(row=i, column=1, sticky="we", padx=10, pady=8)
        dlg.columnconfigure(1, weight=1)
        error.grid(row=3, column=0, columnspan=2, padx=10)

        def submit(_event=None):
            self.client.config["server"] = server.get().strip() or self.client.config["server"]
            try:
                self.client.login(user.get().strip(), pwd.get())
            except ApiError as err:
                error.config(text=str(err))
                return
            try:
                self.client.sync()
            except ApiError:
                pass  # sem rede tudo bem: o cache local ja serve
            self.core.refresh()
            dlg.destroy()

        tk.Button(dlg, text="Sign in", command=submit).grid(row=4, column=1, sticky="e", padx=10, pady=10)
        dlg.bind("<Return>", submit)
        dlg.bind("<Escape>", lambda _e: dlg.destroy())
        dlg.focus_force()
        self.root.wait_window(dlg)

    # ---------------- render ----------------
    def on_query_changed(self):
        self.core.set_query(self.var.get())
        self.render()

    def render(self):
        for child in self.list.winfo_children():
            child.destroy()

        for i, row in enumerate(self.core.rows[:MAX_VISIBLE]):
            self.build_row(i, row)

        self.status.config(text=self.core.status())
        self.place()

    def build_row(self, index, row):
        selected = index == self.core.sel
        bg = BG_SEL if selected else BG

        holder = tk.Frame(self.list, bg=bg, height=ROW_HEIGHT)
        holder.pack(fill="x")
        holder.pack_propagate(False)

        text = tk.Frame(holder, bg=bg)
        text.pack(side="left", fill="both", expand=True, padx=(16, 8), pady=5)
        tk.Label(text, text=row.title, bg=bg, fg=FG, font=self.f_title,
                 anchor="w").pack(fill="x")
        if row.subtitle:
            tk.Label(text, text=row.subtitle, bg=bg, fg=FG_DIM, font=self.f_sub,
                     anchor="w").pack(fill="x")

        if row.badges:
            meta = tk.Frame(holder, bg=bg)
            meta.pack(side="right", padx=(0, 16))
            for kind, label in row.badges:
                tk.Label(meta, text=label, bg=BADGE.get(kind, BADGE["tag"]), fg=FG,
                         font=self.f_badge, padx=6).pack(side="left", padx=2)

        # A click also selects and opens.
        for widget in (holder, text, *text.winfo_children()):
            widget.bind("<Button-1>", lambda _e, i=index: self.select_and_run(i))

    def select_and_run(self, index):
        self.core.select(index)
        self.activate()

    # ---------------- actions ----------------
    def activate(self, index=None):
        action, payload = self.core.activate(index)
        if action == OPEN:
            vmplatform.open_url(payload)
            self.hide()
        elif action == ADDED:
            self.var.set("")
            self.render()
            self.sync_async()
        elif action == ERROR:
            self.status.config(text=payload)

    def copy_selected(self):
        url = self.core.copy_selected()
        if url:
            self.root.clipboard_clear()
            self.root.clipboard_append(url)
        self.status.config(text=self.core.status())

    def delete_selected(self):
        if self.core.delete_selected():
            self.render()
            self.sync_async()

    def on_key(self, event):
        key = event.keysym
        ctrl = bool(event.state & 0x4)
        cmd = bool(event.state & 0x8)   # Command no macOS
        mod = ctrl or cmd

        if key == "Escape":
            if self.var.get():
                self.var.set("")
            else:
                self.hide()
        elif key == "Down" or key == "Tab" or (mod and key == "n"):
            self.core.move(1)
            self.render()
        elif key == "Up" or key == "ISO_Left_Tab" or (mod and key == "p"):
            self.core.move(-1)
            self.render()
        elif key == "Return":
            self.activate()
        elif mod and key == "c":
            self.copy_selected()
        elif mod and key == "d":
            self.delete_selected()
        elif mod and key == "r":
            self.sync_async()
        elif cmd and key == "w":
            self.hide()
        else:
            return None
        return "break"

    # ---------------- sync ----------------
    def sync_async(self):
        if not self.client.authenticated:
            return

        def work():
            try:
                # Its own SQLite connection: sqlite3 is not thread-safe across threads.
                applied = Client().sync()
                self.root.after(0, self.on_synced, applied, None)
            except ApiError as err:
                self.root.after(0, self.on_synced, 0, str(err))

        threading.Thread(target=work, daemon=True).start()

    def on_synced(self, applied, error):
        if self.core.on_sync_result(applied, error):
            self.render()

    # ---------------- daemon ----------------
    def serve(self, path):
        """Listens on the socket so the launcher can wake the bar."""
        self.listener = vmipc.Listener(path, lambda msg: self.root.after(0, self.show))
        self.listener.start()

    def run(self):
        try:
            self.root.mainloop()
        finally:
            if self.listener:
                self.listener.close()


def run(argv):
    daemon = "--daemon" in argv
    path = vmplatform.socket_path()

    # A daemon already there? Just ask it to show up and exit: the fast path.
    if vmipc.send(path, vmipc.SHOW):
        return 0

    bar = Bar(daemon=daemon)
    try:
        bar.serve(path)
    except OSError:
        pass  # raced with another daemon: carry on as a loose instance
    bar.run()
    return 0
