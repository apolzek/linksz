"""All of the bar's logic, with no GTK or Tk dependency.

The views (bookmarks_gtk.py, bookmarks_tk.py) only draw what this module decides and
send the keys back. That keeps Linux and macOS behaving identically and, more
importantly, makes the whole bar testable without a display.

The bar reads and never writes. Search, open, copy: creating, editing and
deleting live in the web UI, and the account it connects to comes from the
config file, so the bar never asks anyone to sign in or sign up.
"""

from bookmarks_search import search

MAX_RESULTS = 12

# Actions returned by activate(), for the view to carry out.
OPEN = "open"
NOTHING = "nothing"


class Row:
    """One row of the list, ready to draw."""

    __slots__ = ("kind", "title", "subtitle", "badges", "bookmark")

    def __init__(self, kind, title, subtitle="", badges=(), bookmark=None):
        self.kind = kind          # only "result": the bar lists bookmarks
        self.title = title
        self.subtitle = subtitle
        self.badges = list(badges)  # [(kind, text)], kind: folder | cat | tag
        self.bookmark = bookmark

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


def _subtitle_of(bookmark):
    """The URL, plus how often it was opened from here, like the web UI shows."""
    url = bookmark.get("url", "")
    try:
        opens = int(bookmark.get("opens") or 0)
    except (TypeError, ValueError):
        opens = 0
    return f"{url}   {opens}\u00d7" if opens > 0 else url


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
        found = search(self._all, self.query, self.max_results)
        self.rows = [
            Row("result", b.get("title") or b.get("url") or "(no title)",
                _subtitle_of(b), _badges_of(b), bookmark=b)
            for b in found
        ]
        self.sel = 0

    @property
    def total(self):
        return len(self._all)

    def status(self):
        if self.message:
            return self.message
        if not self.query:
            return (f"{self.total} bookmarks · #tag  @category  /folder · "
                    f'-term excludes · "phrase" literal')
        if not self.rows:
            return f"nothing found for «{self.query}»"
        return f"{len(self.rows)} of {self.total} · Enter opens · Ctrl+C copies"

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

        # Counts towards the ranking: the bar is the launcher, so most of the
        # opens happen here and not in the web UI. It is also the only thing
        # the bar ever writes.
        if row.bookmark.get("id"):
            try:
                self.client.register_open(row.bookmark["id"])
            except Exception:
                pass          # a statistic must never keep a link from opening
        return (OPEN, row.bookmark.get("url", ""))

    def copy_selected(self):
        """Returns the URL to copy (the view touches the clipboard), or None."""
        row = self.selected()
        if row is None or row.kind != "result":
            return None
        url = row.bookmark.get("url", "")
        self.message = f"copied: {url}" if url else "this bookmark has no url"
        return url or None

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
