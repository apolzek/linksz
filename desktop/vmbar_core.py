"""Toda a logica da barra, sem depender de GTK nem de Tk.

As views (vmbar_gtk.py, vmbar_tk.py) so desenham o que este modulo decide e
mandam de volta as teclas. Isso mantem Linux e macOS com comportamento
identico e — o que importa mais — deixa a barra inteira testavel sem display.
"""

from vmclient import parse_quick_add
from vmsearch import search

MAX_RESULTS = 12

# Acoes devolvidas por activate(), para a view executar.
OPEN = "open"
ADDED = "added"
ERROR = "error"
NOTHING = "nothing"


class Row:
    """Uma linha da lista, ja pronta para desenhar."""

    __slots__ = ("kind", "title", "subtitle", "badges", "bookmark", "parsed")

    def __init__(self, kind, title, subtitle="", badges=(), bookmark=None, parsed=None):
        self.kind = kind          # "result" ou "add"
        self.title = title
        self.subtitle = subtitle
        self.badges = list(badges)  # [(tipo, texto)] — tipo: folder | cat | tag
        self.bookmark = bookmark
        self.parsed = parsed

    def __repr__(self):
        return f"Row({self.kind}, {self.title!r})"


def _badges_of(bookmark, max_tags=3):
    badges = []
    if bookmark.get("folder"):
        badges.append(("folder", "/" + bookmark["folder"]))
    if bookmark.get("category"):
        badges.append(("cat", "@" + bookmark["category"]))
    for tag in [t for t in (bookmark.get("tags") or "").split(",") if t][:max_tags]:
        badges.append(("tag", "#" + tag))
    return badges


def _describe(parsed):
    bits = [parsed["url"] or "(sem url)"]
    if parsed["title"]:
        bits.append(parsed["title"])
    if parsed["folder"]:
        bits.append("/" + parsed["folder"])
    if parsed["category"]:
        bits.append("@" + parsed["category"])
    bits += ["#" + t for t in parsed["tags"].split(",") if t]
    return "  ".join(bits)


class BarCore:
    def __init__(self, client, max_results=MAX_RESULTS):
        self.client = client
        self.max_results = max_results
        self.query = ""
        self.rows = []
        self.sel = 0
        self.message = ""   # transitoria: "copiado", "removido", erro de sync
        self._all = []
        self.refresh()

    # ---------------- estado ----------------
    def set_query(self, text):
        self.query = text or ""
        self.message = ""
        self.refresh()

    def refresh(self):
        """Recalcula as linhas a partir do cache local (nunca vai na rede)."""
        self._all = self.client.all_bookmarks()

        if self.is_quick_add:
            parsed = parse_quick_add(self.query[1:].strip())
            self.rows = [Row("add", "+ add bookmark", _describe(parsed), parsed=parsed)]
        else:
            found = search(self._all, self.query, self.max_results)
            self.rows = [
                Row("result", b.get("title") or b.get("url") or "(no title)",
                    b.get("url", ""), _badges_of(b), bookmark=b)
                for b in found
            ]

        self.sel = 0

    @property
    def is_quick_add(self):
        return self.query.startswith("+")

    @property
    def total(self):
        return len(self._all)

    def status(self):
        if self.message:
            return self.message
        if self.is_quick_add:
            return "Enter adds the bookmark"
        if not self.query:
            return (f"{self.total} bookmarks · #tag  @category  /folder · "
                    f'-term excludes · "phrase" literal · +url adds')
        if not self.rows:
            return f"nothing found · type «+ {self.query}» to add it as a bookmark"
        return f"{len(self.rows)} of {self.total} · Enter opens · Ctrl+C copies · Ctrl+D deletes"

    # ---------------- navegacao ----------------
    def move(self, delta):
        if not self.rows:
            self.sel = 0
            return self.sel
        self.sel = max(0, min(self.sel + delta, len(self.rows) - 1))
        return self.sel

    def select(self, index):
        if 0 <= index < len(self.rows):
            self.sel = index
        return self.sel

    def selected(self):
        if 0 <= self.sel < len(self.rows):
            return self.rows[self.sel]
        return None

    # ---------------- acoes ----------------
    def activate(self, index=None):
        """Enter. Devolve (acao, payload) para a view executar."""
        if index is not None:
            self.select(index)
        row = self.selected()
        if row is None:
            return (NOTHING, None)

        if row.kind == "add":
            parsed = row.parsed
            if not parsed["url"] and not parsed["title"]:
                self.message = "informe ao menos uma url"
                return (ERROR, self.message)
            bookmark = self.client.add(**parsed)
            self.set_query("")
            self.message = "bookmark added — syncing…"
            return (ADDED, bookmark)

        return (OPEN, row.bookmark.get("url", ""))

    def copy_selected(self):
        """Devolve a URL a copiar (a view mexe no clipboard) ou None."""
        row = self.selected()
        if row is None or row.kind != "result":
            return None
        url = row.bookmark.get("url", "")
        self.message = f"copied: {url}" if url else "this bookmark has no url"
        return url or None

    def delete_selected(self):
        row = self.selected()
        if row is None or row.kind != "result":
            return None
        bookmark = row.bookmark
        keep = self.sel
        self.client.delete(bookmark["id"])
        self.refresh()
        self.sel = min(keep, max(0, len(self.rows) - 1))
        self.message = f"deleted: {bookmark.get('title') or bookmark.get('url')}"
        return bookmark

    def on_sync_result(self, applied, error):
        """Resultado do sync em background. True = a view precisa redesenhar."""
        if error:
            self.message = f"offline — usando cache local ({error})"
            return True
        if applied:
            keep_query, keep_sel = self.query, self.sel
            self.refresh()
            self.query = keep_query
            self.sel = min(keep_sel, max(0, len(self.rows) - 1))
            return True
        return False
