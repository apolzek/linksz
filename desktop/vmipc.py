"""Instancia unica via socket unix.

O daemon fica residente escutando; o atalho global roda o script de novo, que
so entrega a mensagem "show" e sai. Abrir a barra vira um round-trip local em
vez de subir um processo Python inteiro — e a diferenca entre instantaneo e
"esperei meio segundo".

O GTK teria isso de graca no Gtk.Application, mas o Tk (macOS) nao tem nada
equivalente, entao os dois usam este modulo e o comportamento fica igual.
"""

import os
import socket
import threading

SHOW = "show"
PING = "ping"


def send(path, message, timeout=0.5):
    """Entrega uma mensagem ao daemon. False = ninguem escutando."""
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
    """Escuta mensagens e chama on_message(msg) numa thread de fundo.

    on_message roda fora da thread de UI: quem usa precisa agendar de volta
    (GLib.idle_add no GTK, root.after no Tk).
    """

    def __init__(self, path, on_message):
        self.path = path
        self.on_message = on_message
        self.sock = None
        self.thread = None
        self._stop = threading.Event()

    def start(self):
        """Assume o socket. Levanta OSError se outro daemon ja o tem."""
        self._clear_stale()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(self.path)
        os.chmod(self.path, 0o600)
        self.sock.listen(8)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()
        return self

    def _clear_stale(self):
        """Socket orfao de um processo que morreu sem limpar: remove.

        So remove se ninguem responder — senao dois daemons brigariam pelo path.
        """
        if not os.path.exists(self.path):
            return
        if is_running(self.path):
            raise OSError(f"ja existe um daemon escutando em {self.path}")
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
