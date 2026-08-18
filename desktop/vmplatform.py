"""Diferencas entre Linux e macOS num lugar so.

O resto do codigo do desktop nao deve olhar para sys.platform: pergunta aqui.
"""

import os
import shutil
import subprocess
import sys
import tempfile

IS_MAC = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")

APP = "vaultmarks"

# macOS junta config e dados em Application Support; Linux segue o XDG.
_MAC_SUPPORT = "~/Library/Application Support"


def _dir(env_var, mac_default, linux_default):
    """Env var (se houver) > convencao do SO. XDG vale nos dois para os testes."""
    base = os.environ.get(env_var)
    if not base:
        base = mac_default if IS_MAC else linux_default
    return os.path.join(os.path.expanduser(base), APP)


def config_dir():
    return _dir("XDG_CONFIG_HOME", _MAC_SUPPORT, "~/.config")


def data_dir():
    return _dir("XDG_DATA_HOME", _MAC_SUPPORT, "~/.local/share")


def runtime_dir():
    """Onde vive o socket de instancia unica. Precisa ser local e privado."""
    base = os.environ.get("XDG_RUNTIME_DIR")
    if not base:
        # macOS nao tem XDG_RUNTIME_DIR; /tmp por usuario resolve nos dois.
        base = os.path.join(tempfile.gettempdir(), f"{APP}-{os.getuid()}")
    path = os.path.join(base, APP)
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def socket_path():
    return os.path.join(runtime_dir(), "bar.sock")


def open_url_command(url):
    """Comando que abre uma URL no navegador padrao."""
    if not url:
        return None
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return (["open", url] if IS_MAC else ["xdg-open", url])


def open_url(url):
    cmd = open_url_command(url)
    if not cmd:
        return False
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except OSError:
        return False


def copy_command():
    """Fallback de clipboard para quando o toolkit nao da conta."""
    if IS_MAC:
        return ["pbcopy"]
    for cmd in (["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]):
        if shutil.which(cmd[0]):
            return cmd
    return None


def copy_to_clipboard(text):
    cmd = copy_command()
    if not cmd:
        return False
    try:
        subprocess.run(cmd, input=str(text).encode(), check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def available_toolkits():
    """Quais toolkits de UI existem nesta maquina, em ordem de preferencia."""
    found = []
    # No Linux o GTK3 ja vem com o GNOME e integra melhor com o tema.
    # No macOS o Tk vem no proprio Python e o GTK praticamente nunca existe.
    order = ("tk", "gtk") if IS_MAC else ("gtk", "tk")
    for name in order:
        try:
            if name == "gtk":
                import gi  # noqa: F401

                gi.require_version("Gtk", "3.0")
                from gi.repository import Gtk  # noqa: F401
            else:
                import tkinter  # noqa: F401
        except (ImportError, ValueError):
            continue
        found.append(name)
    return found


def pick_toolkit():
    """VAULTMARKS_UI força um toolkit; senao usa o melhor disponivel."""
    forced = os.environ.get("VAULTMARKS_UI", "").strip().lower()
    if forced in ("gtk", "tk"):
        return forced

    found = available_toolkits()
    if found:
        return found[0]

    hint = ("instale o Tk:  brew install python-tk"
            if IS_MAC else
            "instale um toolkit:  sudo apt install python3-gi   (ou python3-tk)")
    raise RuntimeError(f"nenhum toolkit de UI disponivel — {hint}")
