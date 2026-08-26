"""Single instance over a unix socket.

The daemon stays resident listening; the global shortcut runs the script again,
which only delivers the "show" message and exits. Opening the bar becomes a
local round-trip instead of starting a whole Python process, which is the
difference between instant and "I waited half a second".

GTK would get this for free from Gtk.Application, but Tk (macOS) has nothing
equivalent, so both use this module and the behaviour stays identical.
"""

import os
import socket
import threading

SHOW = "show"
PING = "ping"


def send(path, message, timeout=0.5):
    """Delivers a message to the daemon. False = nobody listening."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(path)
            sock.sendall(str(message).encode())
            sock.shutdown(socket.SHUT_WR)
            return True
    except (OSError, socket.timeout):
        return False


def is_running(path, timeout=0.5):
    return send(path, PING, timeout)


class Listener:
    """Listens for messages and calls on_message(msg) on a background thread.

    on_message runs outside the UI thread: the caller has to schedule back
    (GLib.idle_add on GTK, root.after on Tk).
    """

    def __init__(self, path, on_message):
        self.path = path
        self.on_message = on_message
        self.sock = None
        self.thread = None
        self._stop = threading.Event()

    def start(self):
        """Takes over the socket. Raises OSError if another daemon already has it."""
        self._clear_stale()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(self.path)
        os.chmod(self.path, 0o600)
        self.sock.listen(8)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()
        return self

    def _clear_stale(self):
        """Orphan socket from a process that died without cleaning up: remove it.

        Only removed when nobody answers, otherwise two daemons would fight over
        the path.
        """
        if not os.path.exists(self.path):
            return
        if is_running(self.path):
            raise OSError(f"a daemon is already listening on {self.path}")
        os.unlink(self.path)

    def _serve(self):
        while not self._stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                break
            with conn:
                try:
                    data = conn.recv(4096).decode(errors="replace").strip()
                except OSError:
                    continue
            if data and data != PING:
                self.on_message(data)

    def close(self):
        self._stop.set()
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        try:
            os.unlink(self.path)
        except OSError:
            pass
        if self.thread:
            self.thread.join(timeout=1)
