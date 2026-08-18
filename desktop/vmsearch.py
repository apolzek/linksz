"""Search engine of the desktop bar: an exact mirror of web/search.js.

Syntax:
    text             substring in title, url, tags, category, folder, description
    "two words"      substring with a space (literal phrase)
    #tag             tags only
    @category        category only
    /folder          folder only
    field:value      that field only (title, url, description, tag/tags, cat/category, folder)
    -term            excludes (works with any of the forms above)

Terms combine with AND. Everything is substring, case- and accent-insensitive.

Any change here has to happen in web/search.js too: tests/test_desktop.py runs
both implementations and requires identical results.
"""

import re
import unicodedata
from collections import namedtuple

FIELDS = ("title", "url", "tags", "category", "folder", "description")

# Weight of each field in free search: where it matched matters more than how often.
ANY_WEIGHTS = (
    ("title", 60),
    ("url", 50),
    ("tags", 45),
    ("category", 40),
    ("folder", 35),
    ("description", 20),
)

SIGILS = {"#": "tags", "@": "category", "/": "folder"}

FIELD_ALIASES = {
    "title": "title",
    "url": "url",
    "link": "url",
    "desc": "description",
    "description": "description",
    # The field used to be called `notes`; typing `notes:something` still works.
    "note": "description",
    "notes": "description",
    "tag": "tags",
    "tags": "tags",
    "cat": "category",
    "category": "category",
    "folder": "folder",
    "dir": "folder",
}

QUOTES = "\"'"

# Whitespace spelled out by hand (instead of /\s/ and isspace()) because the
# two languages disagree on corners like U+0085 and U+FEFF, and JS <-> Python
# parity has to hold for any input.
WHITESPACE = (
    " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)

FIELD_PREFIX_RE = re.compile(r"^([a-zA-Z]+):(.*)$", re.DOTALL)

# Compares equal to a (field, value, negate) tuple, which is handy in the tests.
Term = namedtuple("Term", "field value negate")


def norm(s):
    s = "" if s is None else str(s)
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c)).lower()


def tokenize(q):
    """Splits on whitespace, keeping quoted runs together.

    The quotes stay in the token; strip_quotes removes them after the prefixes.
    """
    tokens = []
    cur = ""
    quote = ""

    for ch in str("" if q is None else q):
        if quote:
            cur += ch
            if ch == quote:
                quote = ""
        elif ch in QUOTES:
            cur += ch
            quote = ch
        elif ch in WHITESPACE:
            if cur:
                tokens.append(cur)
                cur = ""
        else:
            cur += ch

    if cur:
        tokens.append(cur)
    return tokens


def components(hay):
    """Splits a field into components (tags are csv, titles have spaces).

    Hand-written for the same reason as WHITESPACE: split(/[,\\s]+/) and
    str.split() do not agree on every character.
    """
    out = []
    cur = ""
    for ch in hay:
        if ch == "," or ch in WHITESPACE:
            if cur:
                out.append(cur)
                cur = ""
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def strip_quotes(s):
    """An unclosed quote still counts: `"foo bar` becomes `foo bar`."""
    if s and s[0] in QUOTES:
        q = s[0]
        s = s[1:]
        if s.endswith(q):
            s = s[:-1]
    return s


def parse_token(raw):
    text = raw

    # A sigil with no value (`#`, `-`, `@`) becomes an empty term and is dropped
    # by parse_query: while `#devops` is being typed, a lone `#` must not empty
    # the list.
    negate = text[:1] == "-"
    if negate:
        text = text[1:]

    field = "any"
    if text[:1] in SIGILS:
        field = SIGILS[text[0]]
        text = text[1:]
    else:
        # `field:value`, but only for known fields, otherwise `https://x` would
        # become a filter on a "https" field.
        m = FIELD_PREFIX_RE.match(text)
        if m and m.group(1).lower() in FIELD_ALIASES:
            field = FIELD_ALIASES[m.group(1).lower()]
            text = m.group(2)

    return Term(field, norm(strip_quotes(text)), negate)


def parse_query(q):
    terms = []
    for raw in tokenize(q):
        term = parse_token(raw)
        # Nothing left after the prefixes (e.g. `#`, `""`, `-`): ignore it.
        if term.value:
            terms.append(term)
    return terms


def _fields_of(b):
    return {name: norm(b.get(name)) for name in FIELDS}


def _score_term(f, term):
    """None when it does not match, otherwise a score (higher is better)."""
    value = term.value

    if term.field != "any":
        hay = f[term.field]
        i = hay.find(value)
        if i < 0:
            return None
        # A whole component (tag `go` in `go,golang`) is worth more than a substring.
        exact = value in components(hay)
        return 100 if exact else (70 if i == 0 else 50)

    best = None
    for name, weight in ANY_WEIGHTS:
        i = f[name].find(value)
        if i < 0:
            continue
        score = weight + (25 if i == 0 else 0) + (40 if f[name] == value else 0)
        if best is None or score > best:
            best = score
    return best


def _updated_at(b):
    try:
        return int(b.get("updated_at") or 0)
    except (TypeError, ValueError):
        return 0


def search(bookmarks, q, limit=50):
    terms = parse_query(q)
    out = []

    for b in bookmarks:
        if b.get("deleted"):
            continue

        f = _fields_of(b)
        total = 0
        ok = True

        for term in terms:
            s = _score_term(f, term)
            if term.negate:
                if s is not None:
                    ok = False
                    break
            elif s is None:
                ok = False
                break
            else:
                total += s

        if ok:
            out.append((total, _updated_at(b), b))

    # Ties break by recency. Beyond that the sort is stable in both languages, so
    # input order decides the rest and parity holds.
    out.sort(key=lambda r: (-r[0], -r[1]))
    return [b for _, _, b in out[:limit]]
