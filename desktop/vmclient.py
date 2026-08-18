"""Cliente Vaultmarks: cache SQLite local + sync com o backend.

A barra sempre le do cache local (busca instantanea, funciona offline).
O sync roda em background: empurra o que foi criado/editado localmente
e puxa o que mudou no servidor (incluindo edicoes feitas na web).
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
    def _parse_yaml(self, texto):
        """YAML de config: `chave: valor`, comentario com # e aspas opcionais.

        Nao e um parser de YAML completo de proposito — este arquivo tem cinco
        chaves planas, e o projeto nao carrega dependencia.
        """
        cfg = {}
        for linha in texto.split("\n"):
            linha = linha.split("#", 1)[0].strip() if not linha.strip().startswith("#") else ""
            if not linha or ":" not in linha:
                continue
            chave, valor = linha.split(":", 1)
            valor = valor.strip()
            if len(valor) >= 2 and valor[0] == valor[-1] and valor[0] in "\"'":
                valor = valor[1:-1]
            cfg[chave.strip()] = valor
        return cfg

    def _load_config(self):
        cfg = {}
        try:
            with open(self.config_path, encoding="utf-8") as fh:
                cfg = self._parse_yaml(fh.read())
        except OSError:
            # config.json e o formato antigo: se existir, e lido uma vez e
            # regravado como YAML no primeiro save.
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
        linhas = [
            "# Vaultmarks — desktop bar.",
            "#",
            "# The bar is just a search front-end: every bookmark comes from the",
            "# backend below, the same vault the web UI shows. Point `server` at it",
            "# and authenticate with either `token` or `username` + `password`.",
            "#",
            "# With username/password filled in, the bar logs in by itself and stores",
            "# the token here — you can delete the password afterwards.",
            "",
            "server: %s" % self.config.get("server", DEFAULT_SERVER),
            "username: %s" % self.config.get("username", ""),
            "password: %s" % self.config.get("password", ""),
            "token: %s" % self.config.get("token", ""),
            "",
        ]
        with open(self.config_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(linhas))
        os.chmod(self.config_path, 0o600)  # guarda token e, se houver, senha

    @property
    def authenticated(self):
        return bool(self.config.get("token"))

    def ensure_session(self):
        """Garante sessao valida antes de sincronizar.

        Ordem: token que ja funciona > usuario e senha do YAML > nada (a barra
        abre o dialogo de login). E o que faz a barra mostrar exatamente o mesmo
        vault que a web, sem ninguem digitar senha duas vezes.
        """
        if self.config.get("token"):
            try:
                self._request("/api/me")
                return True
            except ApiError:
                self.config["token"] = ""   # expirado ou de outro servidor

        usuario = (self.config.get("username") or "").strip()
        senha = self.config.get("password") or ""
        if usuario and senha:
            self.login(usuario, senha)
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
              dirty INTEGER DEFAULT 0   -- 1 = precisa ser empurrado pro servidor
            );
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
            """
        )
        # O campo se chamava `notes`: cache criado antes disso mantem a coluna
        # antiga, e o CREATE TABLE acima nao a renomeia sozinho.
        colunas = [c["name"] for c in db.execute("PRAGMA table_info(bookmarks)")]
        if "notes" in colunas and "description" not in colunas:
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

    # ---------------- escritas locais ----------------
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
            raise ApiError(body.get("error") or f"erro HTTP {err.code}") from err
        except urllib.error.URLError as err:
            raise ApiError(f"servidor inacessivel ({self.config['server']})") from err
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
        """Empurra locais sujos, puxa mudancas do servidor. Retorna nº aplicado."""
        if not self.authenticated:
            raise ApiError("nao autenticado")

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
            # Nao sobrescreve alteracao local mais recente ainda nao empurrada.
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
    """'https://x.com titulo #go #cli @studies /dev' -> dict pronto pro add()."""
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
