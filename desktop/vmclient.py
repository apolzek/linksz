"""Client: local SQLite cache + sync with the backend.

The bar always reads from the local cache (instant search, works offline).
The sync runs in the background: it pushes what was created/edited locally and
pulls what changed on the server (including edits made on the web).
"""

import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
import uuid

import vmplatform

CONFIG_DIR = vmplatform.config_dir()
DATA_DIR = vmplatform.data_dir()
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.yaml")
LEGACY_CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
CACHE_PATH = os.path.join(DATA_DIR, "cache.db")
DEFAULT_SERVER = os.environ.get("VAULTMARKS_SERVER", "http://127.0.0.1:8787")

COLUMNS = ("id", "title", "url", "folder", "category", "tags", "description", "created_at", "updated_at", "deleted")


def now_ms():
    return int(time.time() * 1000)


class ApiError(Exception):
    pass


class Client:
    def __init__(self, config_path=CONFIG_PATH, cache_path=CACHE_PATH):
        self.config_path = config_path
        self.cache_path = cache_path
        self.config = self._load_config()
        self.db = self._open_cache()

    # ---------------- config ----------------
    def _parse_yaml(self, text):
        """Config YAML: `key: value`, # comments and optional quotes.

        Deliberately not a full YAML parser: this file has five flat keys and
        the project carries no dependency.
        """
        cfg = {}
        for line in text.split("\n"):
            line = line.split("#", 1)[0].strip() if not line.strip().startswith("#") else ""
            if not line or ":" not in line:
                continue
            key, value = line.split(":", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            cfg[key.strip()] = value
        return cfg

    def _load_config(self):
        cfg = {}
        try:
            with open(self.config_path, encoding="utf-8") as fh:
                cfg = self._parse_yaml(fh.read())
        except OSError:
            # config.json is the old format: when present it is read once and
            # rewritten as YAML on the first save.
            try:
                with open(LEGACY_CONFIG_PATH, encoding="utf-8") as fh:
                    cfg = json.load(fh)
            except (OSError, ValueError):
                cfg = {}

        cfg.setdefault("server", DEFAULT_SERVER)
        cfg.setdefault("token", "")
        cfg.setdefault("username", "")
        cfg.setdefault("password", "")
        return cfg

    def save_config(self):
        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
        lines = [
            "# Vaultmarks desktop bar.",
            "#",
            "# The bar is just a search front-end: every bookmark comes from the",
            "# backend below, the same vault the web UI shows. Point `server` at it",
            "# and authenticate with either `token` or `username` + `password`.",
            "#",
            "# With username/password filled in, the bar logs in by itself and stores",
            "# the token here, so you can delete the password afterwards.",
            "",
            "server: %s" % self.config.get("server", DEFAULT_SERVER),
            "username: %s" % self.config.get("username", ""),
            "password: %s" % self.config.get("password", ""),
            "token: %s" % self.config.get("token", ""),
            "",
        ]
        with open(self.config_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines))
        os.chmod(self.config_path, 0o600)  # holds the token and, if set, the password

    @property
    def authenticated(self):
        return bool(self.config.get("token"))

    def ensure_session(self):
        """Ensures a valid session before syncing.

        Order: a token that already works > username and password from the YAML >
        nothing (the bar opens the login dialog). This is what makes the bar show
        exactly the same vault as the web, without typing a password twice.
        """
        if self.config.get("token"):
            try:
                self._request("/api/me")
                return True
            except ApiError:
                self.config["token"] = ""   # expired, or from another server

        username = (self.config.get("username") or "").strip()
        password = self.config.get("password") or ""
        if username and password:
            self.login(username, password)
            return True
        return False

    # ---------------- cache ----------------
    def _open_cache(self):
        os.makedirs(os.path.dirname(self.cache_path), exist_ok=True)
        db = sqlite3.connect(self.cache_path)
        db.row_factory = sqlite3.Row
        db.executescript(
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS bookmarks (
              id TEXT PRIMARY KEY, title TEXT DEFAULT '', url TEXT DEFAULT '',
              folder TEXT DEFAULT '', category TEXT DEFAULT '', tags TEXT DEFAULT '',
              description TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER,
              deleted INTEGER DEFAULT 0,
              dirty INTEGER DEFAULT 0   -- 1 = still has to be pushed to the server
            );
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
            """
        )
        # The field used to be called `notes`: a cache created before that keeps
        # the old column, and the CREATE TABLE above does not rename it.
        columns = [c["name"] for c in db.execute("PRAGMA table_info(bookmarks)")]
        if "notes" in columns and "description" not in columns:
            db.execute("ALTER TABLE bookmarks RENAME COLUMN notes TO description")
        db.commit()
        return db

    def _meta(self, key, default=None):
        row = self.db.execute("SELECT v FROM meta WHERE k = ?", (key,)).fetchone()
        return row["v"] if row else default

    def _set_meta(self, key, value):
        self.db.execute("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                        (key, str(value)))
        self.db.commit()

    def all_bookmarks(self):
        rows = self.db.execute("SELECT * FROM bookmarks WHERE deleted = 0 ORDER BY updated_at DESC").fetchall()
        return [dict(r) for r in rows]

    def _upsert_local(self, b, dirty=0):
        self.db.execute(
            """INSERT INTO bookmarks (id,title,url,folder,category,tags,description,created_at,updated_at,deleted,dirty)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, url=excluded.url, folder=excluded.folder,
                 category=excluded.category, tags=excluded.tags, description=excluded.description,
                 updated_at=excluded.updated_at, deleted=excluded.deleted, dirty=excluded.dirty""",
            (b["id"], b.get("title", ""), b.get("url", ""), b.get("folder", ""), b.get("category", ""),
             b.get("tags", ""), b.get("description", ""), b.get("created_at") or now_ms(),
             b.get("updated_at") or now_ms(), 1 if b.get("deleted") else 0, dirty),
        )
        self.db.commit()

    # ---------------- local writes ----------------
    def add(self, url="", title="", folder="", category="", tags="", description=""):
        ts = now_ms()
        b = {
            "id": str(uuid.uuid4()), "url": url.strip(),
            "title": (title.strip() or url.strip().replace("https://", "").replace("http://", "").rstrip("/")),
            "folder": folder.strip().strip("/"),
            "category": category.strip().lstrip("@").lower(),
            "tags": normalize_tags(tags), "description": description.strip(),
            "created_at": ts, "updated_at": ts, "deleted": 0,
        }
        self._upsert_local(b, dirty=1)
        return b

    def update(self, bookmark_id, **fields):
        row = self.db.execute("SELECT * FROM bookmarks WHERE id = ?", (bookmark_id,)).fetchone()
        if not row:
            return None
        b = dict(row)
        if "tags" in fields:
            fields["tags"] = normalize_tags(fields["tags"])
        if "category" in fields:
            fields["category"] = str(fields["category"]).strip().lstrip("@").lower()
        if "folder" in fields:
            fields["folder"] = str(fields["folder"]).strip().strip("/")
        b.update(fields)
        b["updated_at"] = now_ms()
        self._upsert_local(b, dirty=1)
        return b

    def delete(self, bookmark_id):
        self.db.execute("UPDATE bookmarks SET deleted = 1, updated_at = ?, dirty = 1 WHERE id = ?",
                        (now_ms(), bookmark_id))
        self.db.commit()

    # ---------------- http ----------------
    def _request(self, path, payload=None, method=None, timeout=8):
        url = self.config["server"].rstrip("/") + path
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
        req.add_header("content-type", "application/json")
        if self.config.get("token"):
            req.add_header("authorization", "Bearer " + self.config["token"])
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.loads(res.read().decode() or "{}")
        except urllib.error.HTTPError as err:
            body = {}
            try:
                body = json.loads(err.read().decode())
            except Exception:
                pass
            raise ApiError(body.get("error") or f"HTTP error {err.code}") from err
        except urllib.error.URLError as err:
            raise ApiError(f"server unreachable ({self.config['server']})") from err
        except (TimeoutError, OSError) as err:
            raise ApiError(str(err)) from err

    def login(self, login, password):
        r = self._request("/api/auth/login", {"login": login, "password": password})
        self.config["token"] = r["token"]
        self.config["username"] = r["user"]["username"]
        self.save_config()
        return r["user"]

    def register(self, email, username, password):
        r = self._request("/api/auth/register", {"email": email, "username": username, "password": password})
        self.config["token"] = r["token"]
        self.config["username"] = r["user"]["username"]
        self.save_config()
        return r["user"]

    def logout(self):
        self.config["token"] = ""
        self.config["username"] = ""
        self.save_config()

    # ---------------- sync ----------------
    def sync(self):
        """Pushes dirty local rows, pulls server changes. Returns how many applied."""
        if not self.authenticated:
            raise ApiError("not authenticated")

        dirty = [dict(r) for r in self.db.execute("SELECT * FROM bookmarks WHERE dirty = 1").fetchall()]
        changes = [{k: d[k] for k in COLUMNS} for d in dirty]
        since = int(self._meta("last_sync", 0))

        r = self._request("/api/sync", {"since": since, "changes": changes})

        if dirty:
            self.db.executemany("UPDATE bookmarks SET dirty = 0 WHERE id = ?", [(d["id"],) for d in dirty])
            self.db.commit()

        applied = 0
        for c in r.get("changes", []):
            local = self.db.execute("SELECT updated_at, dirty FROM bookmarks WHERE id = ?", (c["id"],)).fetchone()
            # Does not overwrite a newer local change that has not been pushed yet.
            if local and local["dirty"] and local["updated_at"] > c["updated_at"]:
                continue
            self._upsert_local(c, dirty=0)
            applied += 1

        self._set_meta("last_sync", r.get("now", now_ms()))
        return applied


def normalize_tags(v):
    if isinstance(v, (list, tuple)):
        parts = v
    else:
        parts = str(v or "").replace(",", " ").split()
    out = []
    for t in parts:
        t = str(t).lstrip("#").strip().lower()
        if t and t not in out:
            out.append(t)
    return ",".join(out)


def parse_quick_add(text):
    """'https://x.com title #go #cli @studies /dev' -> dict ready for add()."""
    url, tags, category, folder, words = "", [], "", "", []
    for tok in text.split():
        if tok.startswith("#") and len(tok) > 1:
            tags.append(tok[1:])
        elif tok.startswith("@") and len(tok) > 1:
            category = tok[1:]
        elif tok.startswith("/") and len(tok) > 1:
            folder = tok[1:]
        elif not url and (tok.startswith(("http://", "https://")) or "." in tok.strip(".")):
            url = tok if tok.startswith(("http://", "https://")) else "https://" + tok
        else:
            words.append(tok)
    return {"url": url, "title": " ".join(words), "tags": ",".join(tags), "category": category, "folder": folder}
