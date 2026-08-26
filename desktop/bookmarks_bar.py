#!/usr/bin/env python3
"""Spotlight-style bookmark search bar.

Picks the view for the system on its own:

    Linux   GTK3 (python3-gi, ships with GNOME)  -> bookmarks_gtk.py
    macOS   Tkinter (comes with Python)          -> bookmarks_tk.py

On both, the first instance stays resident and hidden; the global shortcut runs
the script again, which only wakes the running one, so the bar shows up
instantly instead of starting a Python process every time.

Usage:
    bookmarks_bar.py            opens the bar (or wakes the existing instance)
    bookmarks_bar.py --daemon   starts resident and hidden (autostart)

Variables:
    BOOKMARKS_UI=gtk|tk         forces a toolkit
    BOOKMARKS_NO_AUTOHIDE=1     does not hide when focus is lost
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bookmarks_platform  # noqa: E402


def main(argv=None):
    argv = list(sys.argv if argv is None else argv)

    try:
        toolkit = bookmarks_platform.pick_toolkit()
    except RuntimeError as err:
        print(f"bookmarks: {err}", file=sys.stderr)
        return 1

    if toolkit == "gtk":
        import bookmarks_gtk
        return bookmarks_gtk.run(argv)

    import bookmarks_tk
    return bookmarks_tk.run(argv)


if __name__ == "__main__":
    sys.exit(main())
