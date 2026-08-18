"""All of the bar's logic, with no GTK or Tk dependency.

The views (vmbar_gtk.py, vmbar_tk.py) only draw what this module decides and
send the keys back. That keeps Linux and macOS behaving identically and, more
importantly, makes the whole bar testable without a display.
"""

from vmclient import parse_quick_add
from vmsearch import search

MAX_RESULTS = 12

# Actions returned by activate(), for the view to carry out.
OPEN = "open"
ADDED = "added"
ERROR = "error"
NOTHING = "nothing"


class Row:
    """One row of the list, ready to draw."""

    __slots__ = ("kind", "title", "subtitle", "badges", "bookmark", "parsed")

    def __init__(self, kind, title, subtitle="", badges=(), bookmark=None, parsed=None):
        self.kind = kind          # "result" or "add"
        self.title = title
        self.subtitle = subtitle
        self.badges = list(badges)  # [(kind, text)], kind: folder | cat | tag
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
    bits = [parsed["url"] or "(no url)"]
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
        self.message = ""   # transient: "copied", "deleted", a sync error
        self._all = []
        self.refresh()

    # ---------------- state ----------------
    def set_query(self, text):
        self.query = text or ""
        self.message = ""
        self.refresh()

    def refresh(self):
        """Recomputes the rows from the local cache (never hits the network)."""
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

    # ---------------- navigation ----------------
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

    # ---------------- actions ----------------
    def activate(self, index=None):
        """Enter. Returns (action, payload) for the view to carry out."""
        if index is not None:
            self.select(index)
        row = self.selected()
        if row is None:
            return (NOTHING, None)

        if row.kind == "add":
            parsed = row.parsed
            if not parsed["url"] and not parsed["title"]:
                self.message = "provide at least a url"
                return (ERROR, self.message)
            bookmark = self.client.add(**parsed)
            self.set_query("")
            self.message = "bookmark added, syncing…"
            return (ADDED, bookmark)

        return (OPEN, row.bookmark.get("url", ""))

    def copy_selected(self):
        """Returns the URL to copy (the view touches the clipboard), or None."""
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
        """Result of the background sync. True = the view has to redraw."""
        if error:
            self.message = f"offline, using the local cache ({error})"
            return True
        if applied:
            keep_query, keep_sel = self.query, self.sel
            self.refresh()
            self.query = keep_query
            self.sel = min(keep_sel, max(0, len(self.rows) - 1))
            return True
        return False
