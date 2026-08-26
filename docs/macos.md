# Running on macOS

Works on Intel and Apple Silicon. Node has arm64 builds and the API only uses
built-in modules, so nothing is compiled at install time.

## Install

    git clone git@github.com:nochaosio/bookmarks.nochaos.io.git
    cd bookmarks.nochaos.io
    mise install
    bash desktop/install.sh

It creates two LaunchAgents and two apps:

    ~/Library/LaunchAgents/dev.bookmarks.server.plist   backend at login
    ~/Library/LaunchAgents/dev.bookmarks.bar.plist      bar daemon at login
    ~/Applications/Bookmarks Bar.app                    wakes the bar
    ~/Applications/Bookmarks.app                        the PWA in its own window

## The global shortcut is manual

macOS does not let an arbitrary process register one, so the script stops short
of it and prints the options. Pick one:

    Shortcuts.app     new shortcut > action "Open app" > Bookmarks Bar.app,
                      then set a Keyboard Shortcut in the details panel
    skhd              echo 'cmd - space : open -a "Bookmarks Bar"' >> ~/.skhdrc
    Raycast / Alfred  point a hotkey at Bookmarks Bar.app

## Tkinter

The bar uses Tk on macOS. The system Python has it; a Homebrew Python often
does not:

    brew install python-tk

The installer warns when the Python it found cannot import tkinter.

## The PWA

Open http://127.0.0.1:8787. In Safari 17 or newer, File > Add to Dock. In
Chrome or Edge, the install button in the address bar. Both give a window with
no browser chrome, and the service worker keeps it working offline.

## Files

    ~/Library/Application Support/bookmarks/bookmarks.db   the vault
    ~/Library/Application Support/bookmarks/cache.db       the bar's copy
    ~/Library/Application Support/bookmarks/config.json    the bar's config
    ~/Library/Logs/bookmarks/                              logs

## Day to day

    launchctl kickstart -k gui/$(id -u)/dev.bookmarks.server    restart backend
    launchctl kickstart -k gui/$(id -u)/dev.bookmarks.bar       restart the bar
