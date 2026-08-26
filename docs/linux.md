# Running on Linux

The intended setup: the backend as a user service, the bar resident behind a
global shortcut, and the PWA in the browser at localhost.

## Install

    git clone git@github.com:nochaosio/bookmarks.nochaos.io.git
    cd bookmarks.nochaos.io
    mise install
    bash desktop/install.sh

`mise` is optional; it pins Node 24 and Python 3.12. Without it, have both on
the PATH.

The script does four things:

    ~/.config/systemd/user/bookmarks.service      backend on 127.0.0.1:8787
    ~/.config/autostart/bookmarks.desktop         bar daemon at login
    ~/.local/share/applications/*.desktop         launchers in the menu
    gsettings custom-keybinding                   Super+Space opens the bar

Another shortcut: `bash desktop/install.sh '<Super>b'`.

If Super+Space is taken by the input-source switcher, the script frees that one
key and leaves the action's other shortcuts alone.

## Requirements

Node 24 (the API uses `node:sqlite`), and Python 3 with GTK3 for the bar:

    sudo apt install python3-gi          # GNOME, recommended
    sudo apt install python3-tk          # fallback view

## Day to day

    systemctl --user status bookmarks    is the backend up
    systemctl --user restart bookmarks   after pulling changes
    journalctl --user -u bookmarks -f    logs

    pkill -f bookmarks_bar.py            restart the bar
    setsid python3 desktop/bookmarks_bar.py --daemon &

Open http://127.0.0.1:8787 in the browser. That is a secure context, so the
PWA installs and works offline from there.

## The bar

Super+Space, type, Enter opens. Up and down or Tab navigate, Ctrl+C copies the
URL, Ctrl+R forces a sync, Esc clears and then closes.

It reads and never writes: creating, editing and deleting live in the web UI.
The account comes from `~/.config/bookmarks/config.json`:

    server: http://127.0.0.1:8787
    username: your-user
    password: your-password

It signs in by itself and stores the token there; the password can go after the
first run. There is no login dialog and no way to register from the bar.

## Files

    ~/.local/share/bookmarks/bookmarks.db    the vault
    ~/.local/share/bookmarks/cache.db        the bar's local copy
    ~/.config/bookmarks/config.json          the bar's config

The vault is one SQLite file. Copying it while the server runs is not a backup:
use `mise run server` down, or export YAML from the web UI.
