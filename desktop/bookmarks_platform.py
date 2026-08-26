"""Linux and macOS differences in a single place.

The rest of the desktop code should never look at sys.platform: it asks here.
"""

import os
import shutil
import subprocess
import sys
import tempfile

IS_MAC = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")

APP = "bookmarks"

# macOS puts config and data together in Application Support; Linux follows XDG.
_MAC_SUPPORT = "~/Library/Application Support"


def _dir(env_var, mac_default, linux_default):
    """Env var (when set) > OS convention. XDG applies to both, for the tests."""
    base = os.environ.get(env_var)
    if not base:
        base = mac_default if IS_MAC else linux_default
    return os.path.join(os.path.expanduser(base), APP)


def config_dir():
    return _dir("XDG_CONFIG_HOME", _MAC_SUPPORT, "~/.config")


def data_dir():
    return _dir("XDG_DATA_HOME", _MAC_SUPPORT, "~/.local/share")


def runtime_dir():
    """Where the single-instance socket lives. It has to be local and private."""
    base = os.environ.get("XDG_RUNTIME_DIR")
    if not base:
        # macOS has no XDG_RUNTIME_DIR; a per-user /tmp works on both.
        base = os.path.join(tempfile.gettempdir(), f"{APP}-{os.getuid()}")
    path = os.path.join(base, APP)
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def socket_path():
    return os.path.join(runtime_dir(), "bar.sock")


def open_url_command(url):
    """The command that opens a URL in the default browser."""
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
    """Clipboard fallback for when the toolkit cannot do it."""
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
    """Which UI toolkits exist on this machine, in order of preference."""
    found = []
    # On Linux GTK3 ships with GNOME and matches the theme better.
    # On macOS Tk comes with Python itself and GTK is almost never there.
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
    """BOOKMARKS_UI forces a toolkit; otherwise the best available one is used."""
    forced = os.environ.get("BOOKMARKS_UI", "").strip().lower()
    if forced in ("gtk", "tk"):
        return forced

    found = available_toolkits()
    if found:
        return found[0]

    hint = ("install Tk:  brew install python-tk"
            if IS_MAC else
            "install a toolkit:  sudo apt install python3-gi   (or python3-tk)")
    raise RuntimeError(f"no UI toolkit available: {hint}")
