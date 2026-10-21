# Browser extension

Saves the page you are on to your Bookmarks vault and searches it from the
address bar. It talks to the same backend as the app, through the same API,
with a session of its own. Nothing in here is needed to run the app; nothing
outside here is needed to run the extension, except a server to talk to.

Chromium, Manifest V3, no dependencies and no build step: the folder is the
extension.

## Install

On Omarchy, or any Chromium that reads `~/.config/chromium-flags.conf`:

    bash extension/install.sh            add it, then restart Chromium
    bash extension/install.sh --remove   take it out again

It adds this folder to the `--load-extension` line Omarchy already keeps there
for its own extensions, and leaves the previous file next to it as `.bak`.

Elsewhere, and in branded Google Chrome (which ignores `--load-extension`):
`chrome://extensions`, turn on Developer mode, "Load unpacked", pick this
folder.

## Connect

Click the Bookmarks button, check the server (`http://localhost:8080` by
default) and click **Connect through the app**:

1. The extension makes a one-time nonce, keeps it in memory, and opens
   `<server>/#/connect/<extension id>/<nonce>`.
2. The app, signed in already, asks "Connect the browser extension?".
3. On yes, it makes a new session, named "Browser extension", and hands the
   token to that extension id with the nonce (`externally_connectable`, which
   only lets `localhost` and `127.0.0.1` pages talk to it).
4. The extension keeps the token only if the message comes from the server it
   opened, with the nonce it made, within ten minutes. Any other page handing
   it a token is refused.

The access key never passes through the extension. For a server that is not
this machine, or a browser without the app signed in, **Use the access key
instead** exchanges the key for a session the same way the app does, and
keeps the session, not the key.

## What it keeps, and where

| What | Where | Lives |
|---|---|---|
| server, session token, vault name, last folder | `chrome.storage.local` | until disconnected |
| the nonce of a connection in progress | `chrome.storage.session` | in memory, gone when the browser closes |
| the access key | nowhere | |

`chrome.storage.local` is on disk in the browser profile, readable by this
extension and not by the pages it runs next to. It is the same protection the
app's token has in `localStorage`. The server keeps only a hash of the token.

The session shows up in the app under **Settings > Devices**, where it can be
signed out on its own. A new access key signs it out too. Either way the next
call gets a 401, the extension drops the token and asks to connect again.

## Use

* **Popup** (<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>): the page on screen
  with its title and a folder (the last one used, `Temporary` at first),
  whether it is saved already and where, Save and Undo, and a search box.
* **Address bar**: `bm`, a space, then what you are looking for. Enter opens
  the first match, or the one picked, and counts the open.
* **Right click**: "Save page to Bookmarks", "Save link to Bookmarks". Both go
  to `Temporary`, and a page saved already is not saved twice.
* **The button** shows ✓ on a page that is in the vault, ! when not connected.

Everything it changes is marked `extension` in the app's audit log (the
`X-Bookmarks-Via` header).

## What it needs from the server

The API the app uses, plus:

* `POST /api/auth/session`: a signed-in client asks for a new session for
  another one.
* `GET /api/auth/sessions`, `POST /api/auth/sessions/revoke`: the Devices list.
* `GET /api/bookmarks?url=`: is this page saved already. Only a trailing slash
  is ignored, the same rule as the app's `sameLink`.
* `GET /api/folders` answers `used` too: the folders bookmarks are in, so the
  extension has the whole tree without loading every bookmark.

No CORS: an extension with permission for a host is not held to it, so
`BOOKMARKS_ALLOWED_ORIGINS` stays empty.

## Tests

    node --test extension/test/*.test.mjs   the pure pieces, the client against
                                            the real backend, the installer
    bash extension/test/e2e.sh              the extension in Chromium

`bash tests/run.sh` runs the first, `bash tests/run.sh --web` both. The browser
test runs `--headless=new`, since the old headless mode loads no extensions; it
delivers no input events either, so it clicks through the DOM.

## Layout

    manifest.json
    popup.html, popup.js, popup.css   connect, save, search
    options.html, options.js          what it is connected to
    src/lib.js                        pure: servers, folders, the omnibox, the nonce check
    src/client.js                     the API calls, fetch passed in
    src/state.js                      chrome.storage, and a 401 drops the token
    src/background.js                 the connection, right click, address bar, the ✓
    install.sh
    test/
