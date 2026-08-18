#!/usr/bin/env python3
"""Desktop side tests.

Covers, with no display needed:
  * the Python search engine and its parity with the JS one
  * the bar core (BarCore), which is what GTK and Tk share
  * the platform layer (paths and commands for Linux vs macOS)
  * the single instance over a socket, which lets the global shortcut wake the bar
  * the real flow against the Node server: offline, sync, two clients

What stays out: the drawing itself (GTK/Tk widgets). The Tk view is exercised
with a fake tkinter in TestViewTk, which validates the key routing.
"""

import copy
import json
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "desktop"))

# Isolates the tests' config/cache/socket from whatever exists on the machine.
_SANDBOX = tempfile.mkdtemp(prefix="vm-test-home-")
os.environ["XDG_CONFIG_HOME"] = os.path.join(_SANDBOX, "config")
os.environ["XDG_DATA_HOME"] = os.path.join(_SANDBOX, "data")
os.environ["XDG_RUNTIME_DIR"] = os.path.join(_SANDBOX, "run")
os.makedirs(os.environ["XDG_RUNTIME_DIR"], mode=0o700, exist_ok=True)

import vmipc  # noqa: E402
import vmplatform  # noqa: E402
from vmbar_core import ADDED, ERROR, NOTHING, OPEN, BarCore  # noqa: E402
from vmclient import ApiError, Client, normalize_tags, parse_quick_add  # noqa: E402
from vmsearch import components, parse_query, search, tokenize  # noqa: E402

FIXTURES = [
    {"id": "1", "title": "Kubernetes Docs", "url": "https://kubernetes.io/docs", "folder": "dev/infra",
     "category": "studies", "tags": "k8s,devops", "description": "", "updated_at": 5, "deleted": 0},
    {"id": "2", "title": "The Go Blog", "url": "https://go.dev/blog", "folder": "dev",
     "category": "studies", "tags": "go,backend", "description": "", "updated_at": 4, "deleted": 0},
    {"id": "3", "title": "Hacker News", "url": "https://news.ycombinator.com", "folder": "diario",
     "category": "news", "tags": "noticias", "description": "leitura diaria", "updated_at": 3, "deleted": 0},
    {"id": "4", "title": "Grafana", "url": "https://grafana.com", "folder": "dev/infra",
     "category": "work", "tags": "observabilidade,devops", "description": "", "updated_at": 2, "deleted": 0},
    {"id": "5", "title": "Página com Acentuação", "url": "https://example.com/page", "folder": "",
     "category": "work", "tags": "golanguage", "description": "", "updated_at": 1, "deleted": 0},
    {"id": "6", "title": "Excluido", "url": "https://excluido.com", "folder": "", "category": "",
     "tags": "", "description": "", "updated_at": 9, "deleted": 1},
]


def titles(rows):
    return [r["title"] for r in rows]


def t(query, limit=50):
    return titles(search(FIXTURES, query, limit))


class TestSubstringSearch(unittest.TestCase):
    def test_substring_at_any_position(self):
        self.assertEqual(t("kuber"), ["Kubernetes Docs"])
        self.assertEqual(t("bernet"), ["Kubernetes Docs"])
        self.assertEqual(t("ycombinator"), ["Hacker News"])
        self.assertEqual(t("diaria"), ["Hacker News"])

    def test_case_insensitive(self):
        self.assertEqual(t("BERNET"), ["Kubernetes Docs"])
        self.assertEqual(t("KuBeRnEtEs"), ["Kubernetes Docs"])

    def test_ignores_accents_both_ways(self):
        self.assertEqual(t("acentuacao"), ["Página com Acentuação"])
        self.assertEqual(t("Acentuação"), ["Página com Acentuação"])
        self.assertEqual(t("PAGINA"), ["Página com Acentuação"])

    def test_special_characters_are_literal(self):
        self.assertEqual(t("go.dev"), ["The Go Blog"])
        self.assertEqual(t(".*"), [], "must not be treated as a regex")
        self.assertEqual(t("["), [])
        self.assertEqual(t("kubernetes.io/docs"), ["Kubernetes Docs"])


class TestBuscaPorCampo(unittest.TestCase):
    def test_tag(self):
        self.assertEqual(sorted(t("#devops")), ["Grafana", "Kubernetes Docs"])
        self.assertEqual(t("#k8s"), ["Kubernetes Docs"])
        self.assertEqual(t("#inexistente"), [])
        self.assertEqual(t("#Hacker"), [], "a title does not enter a tag search")

    def test_category(self):
        self.assertEqual(sorted(t("@studies")), ["Kubernetes Docs", "The Go Blog"])
        self.assertEqual(sorted(t("@stud")), ["Kubernetes Docs", "The Go Blog"])
        self.assertEqual(t("@grafana"), [])

    def test_parent_folder_matches_children(self):
        self.assertEqual(sorted(t("/dev/infra")), ["Grafana", "Kubernetes Docs"])
        self.assertEqual(len(t("/dev")), 3)

    def test_field_value(self):
        self.assertEqual(t("title:go"), ["The Go Blog"])
        self.assertEqual(t("url:ycombinator"), ["Hacker News"])
        self.assertEqual(t("description:diaria"), ["Hacker News"])
        self.assertEqual(sorted(t("cat:work")), ["Grafana", "Página com Acentuação"])
        self.assertEqual(t("title:grafana.com"), [], "a url does not match when the field is title")

    def test_url_does_not_become_field_value(self):
        self.assertEqual(len(t("https://")), 5)
        self.assertEqual(parse_query("https://go.dev")[0].field, "any")


class TestBuscaFrasesENegacao(unittest.TestCase):
    def test_quoted_phrase(self):
        self.assertEqual(t('"hacker news"'), ["Hacker News"])
        self.assertEqual(t('"news hacker"'), [], "ordem importa dentro da frase")
        self.assertEqual(t("hacker news"), ["Hacker News"], "sem aspas sao dois termos com AND")
        self.assertEqual(t('title:"go blog"'), ["The Go Blog"])

    def test_single_quotes_count_too(self):
        self.assertEqual(t("'hacker news'"), ["Hacker News"])

    def test_negation(self):
        self.assertEqual(t("#devops -#k8s"), ["Grafana"])
        self.assertEqual(t("/dev -@studies"), ["Grafana"])
        self.assertEqual(t("#devops -grafana"), ["Kubernetes Docs"])
        self.assertEqual(t("#devops -#devops"), [])

    def test_negation_alone_lists_the_rest(self):
        self.assertEqual(len(t("-#devops")), len(t("")) - 2)
        self.assertNotIn("Grafana", t("-#devops"))

    def test_quotes_protect_the_hyphen(self):
        term = parse_query('"-not-a-negation"')[0]
        self.assertFalse(term.negate)
        self.assertEqual(term.value, "-not-a-negation")


class TestRanking(unittest.TestCase):
    def test_exact_tag_above_substring(self):
        self.assertEqual(t("#go")[0], "The Go Blog")
        self.assertIn("Página com Acentuação", t("#go"))

    def test_title_weighs_more_than_description(self):
        itens = [
            {"id": "a", "title": "nada", "description": "zebra", "updated_at": 2},
            {"id": "b", "title": "zebra", "description": "", "updated_at": 1},
        ]
        self.assertEqual([b["id"] for b in search(itens, "zebra")], ["b", "a"])

    def test_ties_break_by_recency(self):
        itens = [
            {"id": "velho", "title": "igual", "updated_at": 1},
            {"id": "novo", "title": "igual", "updated_at": 9},
        ]
        self.assertEqual([b["id"] for b in search(itens, "igual")], ["novo", "velho"])

    def test_updated_at_missing_or_invalid(self):
        itens = [
            {"id": "a", "title": "igual"},
            {"id": "b", "title": "igual", "updated_at": None},
            {"id": "c", "title": "igual", "updated_at": "lixo"},
        ]
        self.assertEqual(len(search(itens, "igual")), 3)


class TestParserEBordas(unittest.TestCase):
    def test_tokenize(self):
        self.assertEqual(tokenize("a b  c"), ["a", "b", "c"])
        self.assertEqual(tokenize('"duas words" solta'), ['"duas words"', "solta"])
        self.assertEqual(tokenize("   "), [])
        self.assertEqual(tokenize(None), [])

    def test_tokenize_unclosed_quotes(self):
        self.assertEqual(tokenize('"sem fechar'), ['"sem fechar'])
        self.assertEqual(parse_query('"sem fechar')[0].value, "sem fechar")

    def test_parse_query_sigils(self):
        self.assertEqual(parse_query("#a @b /c livre"),
                         [("tags", "a", False), ("category", "b", False),
                          ("folder", "c", False), ("any", "livre", False)])

    def test_parse_query_field_aliases(self):
        for texto, campo in (("title:x", "title"), ("link:x", "url"), ("note:x", "description"),
                             ("tag:x", "tags"), ("cat:x", "category"), ("dir:x", "folder"),
                             ("TITLE:x", "title")):
            self.assertEqual(parse_query(texto)[0].field, campo, texto)

    def test_lone_sigil_is_ignored(self):
        # Typing "#" on the way to "#devops" must not empty the list.
        for q in ("#", "@", "/", "-", '""', "''", "  ", ""):
            self.assertEqual(parse_query(q), [], repr(q))
        self.assertEqual(t("#"), t(""))

    def test_deleted_never_show_up(self):
        self.assertNotIn("Excluido", t(""))
        self.assertEqual(t("excluido.com"), [])

    def test_limit(self):
        self.assertEqual(len(t("", limit=2)), 2)
        self.assertEqual(len(t("", limit=0)), 0)

    def test_empty_list_and_missing_fields(self):
        self.assertEqual(search([], "x"), [])
        self.assertEqual(len(search([{"id": "x"}], "")), 1)
        self.assertEqual(search([{"id": "x"}], "qualquer"), [])

    def test_components(self):
        self.assertEqual(components("a,b c"), ["a", "b", "c"])
        self.assertEqual(components(""), [])


class TestParityWithJS(unittest.TestCase):
    """The bar (Python) and the web (JS) have to answer a query identically.

    They are two engines written by hand in different languages; without this
    test the divergence only shows up when someone searches the same thing in
    both places and sees different results.
    """

    QUERIES = [
        "", "   ", "kuber", "BERNET", "ycombinator", "go.dev", "#devops", "#go",
        "@studies", "@stud", "/dev", "/dev/infra", "#devops @work", "acentuacao",
        "pagina", "diaria", "inexistente", "https://", "#k8s @studies /dev/infra",
        # advanced syntax
        '"hacker news"', '"news hacker"', "'single quotes'", 'title:"go blog"',
        "title:go", "url:ycombinator", "description:diaria", "cat:work", "dir:dev",
        "-grafana", "#devops -#k8s", "/dev -@studies", "-#devops", '-"hacker news"',
        "#devops -#devops", "foo:bar", "TITLE:go",
        # edge cases
        "#", "@", "/", "-", '""', '"', "-#", "//", "@@", ".*", "[", "a b c",
        "  double  space  ", "ÁÉÍ", " nbsp", "x﻿y",
    ]

    @classmethod
    def run_js(cls, fixtures, queries):
        script = """
          const {search} = require(process.argv[1]);  // com -e, argv[1] e o 1o argumento
          const {fixtures, queries} = JSON.parse(require('fs').readFileSync(0, 'utf8'));
          console.log(JSON.stringify(queries.map((q) => search(fixtures, q, 50).map((b) => b.id))));
        """
        proc = subprocess.run(
            ["node", "-e", script, os.path.join(ROOT, "web", "search.js")],
            input=json.dumps({"fixtures": fixtures, "queries": queries}),
            capture_output=True, text=True, check=True,
        )
        return json.loads(proc.stdout)

    def test_known_queries(self):
        expected = self.run_js(FIXTURES, self.QUERIES)
        for query, js_ids in zip(self.QUERIES, expected):
            py_ids = [b["id"] for b in search(FIXTURES, query, 50)]
            self.assertEqual(py_ids, js_ids, f"divergencia na query {query!r}")

    def test_fuzz(self):
        """Generates random queries and vaults: catches what the fixed list misses."""
        rnd = random.Random(20260813)
        words = ["kuber", "go", "golang", "dev", "infra", "news", "café", "Ação",
                    "web dev", "k8s", "devops", "a,b", "https://x.com", "TÍTULO", "", "ícone"]
        sigils = ["", "#", "@", "/", "-", "-#", "-@", '"', "title:", "tag:", "cat:",
                   "folder:", "url:", "description:", "https:", "-title:"]

        vault = [{
            "id": str(i),
            "title": rnd.choice(words), "url": rnd.choice(words),
            "folder": rnd.choice(words), "category": rnd.choice(words),
            "tags": ",".join(rnd.sample(words, k=rnd.randint(0, 3))),
            "description": rnd.choice(words),
            "updated_at": rnd.choice([rnd.randint(0, 100), None, 0]),
            "deleted": rnd.choice([0, 0, 0, 1]),
        } for i in range(30)]

        queries = []
        for _ in range(250):
            parts = []
            for _ in range(rnd.randint(1, 3)):
                word = rnd.choice(words)
                if " " in word and rnd.random() < 0.7:
                    word = f'"{word}"'
                parts.append(rnd.choice(sigils) + word)
            queries.append(" ".join(parts))

        expected = self.run_js(vault, queries)
        for query, js_ids in zip(queries, expected):
            py_ids = [b["id"] for b in search(vault, query, 50)]
            self.assertEqual(py_ids, js_ids, f"divergencia na query {query!r}")


class TestNormalizacao(unittest.TestCase):
    def test_normalize_tags(self):
        self.assertEqual(normalize_tags("#Go, #CLI  kubernetes"), "go,cli,kubernetes")
        self.assertEqual(normalize_tags(["#a", "A", "b"]), "a,b")
        self.assertEqual(normalize_tags(""), "")
        self.assertEqual(normalize_tags(None), "")

    def test_quick_add(self):
        p = parse_quick_add("https://zed.dev editor rapido #rust #editor @dev /ferramentas")
        self.assertEqual(p["url"], "https://zed.dev")
        self.assertEqual(p["title"], "editor rapido")
        self.assertEqual(p["tags"], "rust,editor")
        self.assertEqual(p["category"], "dev")
        self.assertEqual(p["folder"], "ferramentas")

    def test_quick_add_infers_https(self):
        self.assertEqual(parse_quick_add("go.dev #go")["url"], "https://go.dev")

    def test_quick_add_without_url(self):
        p = parse_quick_add("just a title #tag")
        self.assertEqual(p["url"], "")
        self.assertEqual(p["title"], "just a title")


class TestPlatform(unittest.TestCase):
    """Linux and macOS differ in paths and in how a URL is opened."""

    def test_paths_respect_xdg(self):
        self.assertTrue(vmplatform.config_dir().startswith(_SANDBOX))
        self.assertTrue(vmplatform.data_dir().startswith(_SANDBOX))
        self.assertTrue(vmplatform.config_dir().endswith("vaultmarks"))

    def test_paths_macos(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(vmplatform, "IS_MAC", True):
            self.assertIn("Library/Application Support", vmplatform.config_dir())
            self.assertIn("Library/Application Support", vmplatform.data_dir())

    def test_paths_linux(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(vmplatform, "IS_MAC", False):
            self.assertIn(".config", vmplatform.config_dir())
            self.assertIn(".local/share", vmplatform.data_dir())

    def test_open_url_per_system(self):
        with mock.patch.object(vmplatform, "IS_MAC", True):
            self.assertEqual(vmplatform.open_url_command("https://go.dev"), ["open", "https://go.dev"])
        with mock.patch.object(vmplatform, "IS_MAC", False):
            self.assertEqual(vmplatform.open_url_command("https://go.dev"), ["xdg-open", "https://go.dev"])

    def test_open_url_completes_the_scheme(self):
        cmd = vmplatform.open_url_command("go.dev")
        self.assertEqual(cmd[-1], "https://go.dev")
        self.assertIsNone(vmplatform.open_url_command(""))

    def test_socket_lives_in_a_private_directory(self):
        caminho = vmplatform.socket_path()
        mode = os.stat(os.path.dirname(caminho)).st_mode & 0o777
        self.assertEqual(mode, 0o700, "the socket must not sit in an open directory")

    def test_toolkit_can_be_forced(self):
        with mock.patch.dict(os.environ, {"VAULTMARKS_UI": "tk"}):
            self.assertEqual(vmplatform.pick_toolkit(), "tk")
        with mock.patch.dict(os.environ, {"VAULTMARKS_UI": "gtk"}):
            self.assertEqual(vmplatform.pick_toolkit(), "gtk")

    def test_no_toolkit_gives_a_useful_error(self):
        with mock.patch.dict(os.environ, {"VAULTMARKS_UI": ""}), \
             mock.patch.object(vmplatform, "available_toolkits", return_value=[]):
            with self.assertRaises(RuntimeError) as ctx:
                vmplatform.pick_toolkit()
            self.assertIn("install", str(ctx.exception).lower())

    def test_macos_prefers_tk(self):
        """On macOS Tk comes with Python; GTK is almost never there."""
        with mock.patch.object(vmplatform, "IS_MAC", True):
            with mock.patch.dict(sys.modules, {"tkinter": mock.MagicMock()}):
                self.assertEqual(vmplatform.available_toolkits()[0], "tk")


class TestIPCInstanciaUnica(unittest.TestCase):
    """The global shortcut runs the script again; it only wakes the daemon."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vm-ipc-")
        self.path = os.path.join(self.dir, "bar.sock")
        self.recebidas = []

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_send_without_daemon_fails(self):
        self.assertFalse(vmipc.send(self.path, vmipc.SHOW))
        self.assertFalse(vmipc.is_running(self.path))

    def test_daemon_receives_messages(self):
        listener = vmipc.Listener(self.path, self.recebidas.append).start()
        try:
            self.assertTrue(vmipc.is_running(self.path))
            self.assertTrue(vmipc.send(self.path, vmipc.SHOW))
            self.assertTrue(vmipc.send(self.path, vmipc.SHOW))
            for _ in range(50):
                if len(self.recebidas) >= 2:
                    break
                time.sleep(0.02)
            self.assertEqual(self.recebidas, [vmipc.SHOW, vmipc.SHOW])
        finally:
            listener.close()

    def test_ping_does_not_become_a_message(self):
        listener = vmipc.Listener(self.path, self.recebidas.append).start()
        try:
            vmipc.is_running(self.path)
            time.sleep(0.15)
            self.assertEqual(self.recebidas, [], "ping so checa se esta vivo")
        finally:
            listener.close()

    def test_two_daemons_do_not_coexist(self):
        listener = vmipc.Listener(self.path, self.recebidas.append).start()
        try:
            with self.assertRaises(OSError):
                vmipc.Listener(self.path, self.recebidas.append).start()
        finally:
            listener.close()

    def test_orphan_socket_is_taken_over(self):
        """A daemon that died without cleaning up leaves the file; the next one has to take over."""
        open(self.path, "w").close()
        listener = vmipc.Listener(self.path, self.recebidas.append).start()
        try:
            self.assertTrue(vmipc.send(self.path, vmipc.SHOW))
        finally:
            listener.close()

    def test_close_removes_the_socket(self):
        listener = vmipc.Listener(self.path, self.recebidas.append).start()
        listener.close()
        self.assertFalse(os.path.exists(self.path))


class FakeClient:
    """In-memory client: BarCore only needs these four methods."""

    def __init__(self, items=None):
        # Deep copy: delete() sets deleted=1 on the dict, and without this one test
        # would dirty the global FIXTURES for everything that runs afterwards.
        self.items = copy.deepcopy(list(items or []))
        self.deleted = []
        self.added = []

    def all_bookmarks(self):
        return [b for b in self.items if not b.get("deleted")]

    def add(self, url="", title="", folder="", category="", tags="", description=""):
        b = {"id": f"novo-{len(self.added)}", "url": url, "title": title or url,
             "folder": folder, "category": category, "tags": tags, "description": description,
             "updated_at": 100, "deleted": 0}
        self.items.append(b)
        self.added.append(b)
        return b

    def delete(self, bookmark_id):
        self.deleted.append(bookmark_id)
        for b in self.items:
            if b["id"] == bookmark_id:
                b["deleted"] = 1


class TestBarCore(unittest.TestCase):
    """The core GTK and Tk share: everything the bar decides lives here."""

    def setUp(self):
        self.client = FakeClient(FIXTURES)
        self.core = BarCore(self.client)

    def test_lists_everything_without_a_query(self):
        self.assertEqual(len(self.core.rows), 5)
        self.assertEqual(self.core.total, 5)
        self.assertIn("5 bookmarks", self.core.status())

    def test_search_filters(self):
        self.core.set_query("kuber")
        self.assertEqual([r.title for r in self.core.rows], ["Kubernetes Docs"])
        self.assertIn("1 of 5", self.core.status())

    def test_advanced_search_reaches_the_bar(self):
        self.core.set_query("#devops -#k8s")
        self.assertEqual([r.title for r in self.core.rows], ["Grafana"])
        self.core.set_query('"hacker news"')
        self.assertEqual([r.title for r in self.core.rows], ["Hacker News"])

    def test_no_result_suggests_adding(self):
        self.core.set_query("naoexiste")
        self.assertEqual(self.core.rows, [])
        self.assertIn("+ naoexiste", self.core.status())

    def test_row_carries_title_url_and_badges(self):
        self.core.set_query("kuber")
        row = self.core.rows[0]
        self.assertEqual(row.kind, "result")
        self.assertEqual(row.subtitle, "https://kubernetes.io/docs")
        self.assertEqual(row.badges,
                         [("folder", "/dev/infra"), ("cat", "@studies"),
                          ("tag", "#k8s"), ("tag", "#devops")])

    def test_title_falls_back_to_url(self):
        core = BarCore(FakeClient([{"id": "x", "url": "https://so-url.com", "title": ""}]))
        self.assertEqual(core.rows[0].title, "https://so-url.com")

    def test_navigation_respects_the_bounds(self):
        self.assertEqual(self.core.sel, 0)
        self.assertEqual(self.core.move(-1), 0, "does not go past the top")
        self.core.move(1)
        self.assertEqual(self.core.sel, 1)
        self.core.move(50)
        self.assertEqual(self.core.sel, 4, "does not go past the end")

    def test_navigation_with_an_empty_list(self):
        self.core.set_query("naoexiste")
        self.assertEqual(self.core.move(1), 0)
        self.assertIsNone(self.core.selected())

    def test_search_resets_the_selection(self):
        self.core.move(3)
        self.core.set_query("kuber")
        self.assertEqual(self.core.sel, 0)

    def test_enter_opens_the_url(self):
        self.core.set_query("kuber")
        self.assertEqual(self.core.activate(), (OPEN, "https://kubernetes.io/docs"))

    def test_enter_without_a_row_does_nothing(self):
        self.core.set_query("naoexiste")
        self.assertEqual(self.core.activate(), (NOTHING, None))

    def test_quick_add(self):
        self.core.set_query("+ https://zed.dev editor #rust @dev /ferramentas")
        self.assertTrue(self.core.is_quick_add)
        row = self.core.rows[0]
        self.assertEqual(row.kind, "add")
        self.assertIn("https://zed.dev", row.subtitle)
        self.assertIn("#rust", row.subtitle)

        acao, bookmark = self.core.activate()
        self.assertEqual(acao, ADDED)
        self.assertEqual(bookmark["url"], "https://zed.dev")
        self.assertEqual(bookmark["tags"], "rust")
        self.assertEqual(self.core.query, "", "o campo limpa depois de adicionar")

    def test_empty_quick_add_complains(self):
        self.core.set_query("+   ")
        acao, msg = self.core.activate()
        self.assertEqual(acao, ERROR)
        self.assertIn("url", msg)
        self.assertEqual(self.client.added, [])

    def test_copy(self):
        self.core.set_query("kuber")
        self.assertEqual(self.core.copy_selected(), "https://kubernetes.io/docs")
        self.assertIn("copied", self.core.status())

    def test_copy_on_the_add_row_does_nothing(self):
        self.core.set_query("+ algo")
        self.assertIsNone(self.core.copy_selected())

    def test_delete(self):
        self.core.set_query("kuber")
        removido = self.core.delete_selected()
        self.assertEqual(removido["id"], "1")
        self.assertEqual(self.client.deleted, ["1"])
        self.assertEqual(self.core.rows, [], "some da lista na hora")
        self.assertIn("deleted", self.core.status())

    def test_delete_adjusts_the_selection(self):
        self.core.move(4)          # last row
        self.core.delete_selected()
        self.assertEqual(self.core.sel, 3, "the selection must not fall outside the list")

    def test_sync_error_warns_and_keeps_the_cache(self):
        mudou = self.core.on_sync_result(0, "servidor inacessivel")
        self.assertTrue(mudou)
        self.assertIn("offline", self.core.status())
        self.assertEqual(len(self.core.rows), 5, "continua listando do cache")

    def test_sync_without_news_does_not_redraw(self):
        self.assertFalse(self.core.on_sync_result(0, None))

    def test_sync_with_news_keeps_the_search(self):
        self.core.set_query("kuber")
        self.client.items.append({"id": "9", "title": "Kubernetes Extra", "url": "https://k.io",
                                  "tags": "", "category": "", "folder": "", "updated_at": 50})
        self.assertTrue(self.core.on_sync_result(1, None))
        self.assertEqual(self.core.query, "kuber", "the typed search must not vanish")
        self.assertEqual(len(self.core.rows), 2)


class TestViewTk(unittest.TestCase):
    """The macOS path: validates the key routing of the Tk view.

    tkinter is not installed on every CI machine (and there is no display here),
    so it is swapped for a double. This does not validate the drawing: it
    validates that each key calls the right action on the core, where the logic
    lives.
    """

    def setUp(self):
        self.fake_tk = mock.MagicMock()
        self.modules = mock.patch.dict(sys.modules, {
            "tkinter": self.fake_tk,
            "tkinter.font": self.fake_tk.font,
        })
        self.modules.start()
        for mod in ("vmbar_tk",):
            sys.modules.pop(mod, None)

    def tearDown(self):
        self.modules.stop()
        sys.modules.pop("vmbar_tk", None)

    def _bar(self):
        import vmbar_tk

        bar = vmbar_tk.Bar.__new__(vmbar_tk.Bar)   # sem __init__: nada de janela
        bar.client = FakeClient(FIXTURES)
        bar.core = BarCore(bar.client)
        bar.root = mock.MagicMock()
        bar.status = mock.MagicMock()
        bar.var = mock.MagicMock()
        bar.var.get.return_value = ""
        bar.visible = True
        bar.listener = None
        bar.render = mock.MagicMock()
        bar.hide = mock.MagicMock()
        bar.sync_async = mock.MagicMock()
        return bar, vmbar_tk

    @staticmethod
    def _evento(keysym, state=0):
        ev = mock.MagicMock()
        ev.keysym = keysym
        ev.state = state
        return ev

    def test_arrows_navigate(self):
        bar, _ = self._bar()
        bar.on_key(self._evento("Down"))
        self.assertEqual(bar.core.sel, 1)
        bar.on_key(self._evento("Up"))
        self.assertEqual(bar.core.sel, 0)

    def test_control_n_and_p_navigate(self):
        bar, _ = self._bar()
        bar.on_key(self._evento("n", state=0x4))     # Control
        self.assertEqual(bar.core.sel, 1)
        bar.on_key(self._evento("p", state=0x4))
        self.assertEqual(bar.core.sel, 0)

    def test_command_navigates_on_macos(self):
        bar, _ = self._bar()
        bar.on_key(self._evento("n", state=0x8))     # Command
        self.assertEqual(bar.core.sel, 1, "no Mac o modificador natural e Command")

    def test_escape_clears_then_closes(self):
        bar, _ = self._bar()
        bar.var.get.return_value = "algo"
        bar.on_key(self._evento("Escape"))
        bar.var.set.assert_called_with("")
        bar.hide.assert_not_called()

        bar.var.get.return_value = ""
        bar.on_key(self._evento("Escape"))
        bar.hide.assert_called_once()

    def test_enter_opens_and_hides(self):
        bar, vmbar_tk = self._bar()
        with mock.patch.object(vmbar_tk.vmplatform, "open_url") as abrir:
            bar.on_key(self._evento("Return"))
            abrir.assert_called_once()
            self.assertTrue(abrir.call_args[0][0].startswith("http"))
        bar.hide.assert_called_once()

    def test_ctrl_c_copies_to_the_clipboard(self):
        bar, _ = self._bar()
        bar.on_key(self._evento("c", state=0x4))
        bar.root.clipboard_clear.assert_called_once()
        bar.root.clipboard_append.assert_called_once()

    def test_ctrl_d_deletes(self):
        bar, _ = self._bar()
        alvo = bar.core.rows[0].bookmark["id"]
        bar.on_key(self._evento("d", state=0x4))
        self.assertEqual(bar.client.deleted, [alvo])
        bar.sync_async.assert_called_once()

    def test_ctrl_r_syncs(self):
        bar, _ = self._bar()
        bar.on_key(self._evento("r", state=0x4))
        bar.sync_async.assert_called_once()

    def test_unknown_key_passes_through(self):
        bar, _ = self._bar()
        self.assertIsNone(bar.on_key(self._evento("a")), "digitar letra tem que chegar no campo")

    def test_handled_keys_do_not_propagate(self):
        bar, _ = self._bar()
        self.assertEqual(bar.on_key(self._evento("Down")), "break")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class TestSyncWithServer(unittest.TestCase):
    """The real flow against the Node server: write offline, sync, converge."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="vm-py-test-")
        cls.port = free_port()
        cls.proc = subprocess.Popen(
            ["node", os.path.join(ROOT, "server", "server.js")],
            env={**os.environ, "VAULTMARKS_PORT": str(cls.port),
                 "VAULTMARKS_DB": os.path.join(cls.tmp, "vault.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        cls.base = f"http://127.0.0.1:{cls.port}"
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.base + "/api/health", timeout=1)
                break
            except Exception:
                time.sleep(0.05)
        else:
            raise RuntimeError("the server did not come up")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def make_client(self, name):
        """A client with its own config and cache (simulates another machine)."""
        d = os.path.join(self.tmp, name)
        os.makedirs(d, exist_ok=True)
        c = Client(config_path=os.path.join(d, "config.json"), cache_path=os.path.join(d, "cache.db"))
        c.config["server"] = self.base
        return c

    def test_01_register_and_login(self):
        c = self.make_client("reg")
        user = c.register("desktop@example.com", "desktop", "senha123")
        self.assertEqual(user["username"], "desktop")
        self.assertTrue(c.authenticated)

        with self.assertRaises(ApiError):
            c.register("desktop@example.com", "desktop", "senha123")

        c2 = self.make_client("login")
        with self.assertRaises(ApiError):
            c2.login("desktop", "errada")
        c2.login("desktop", "senha123")
        self.assertTrue(c2.authenticated)

    def test_02_token_file_is_locked_down(self):
        c = self.make_client("perm")
        c.login("desktop", "senha123")
        mode = os.stat(c.config_path).st_mode & 0o777
        self.assertEqual(mode, 0o600, "the session token must not be world readable")

    def test_03_add_offline_then_sync(self):
        c = self.make_client("a")
        c.login("desktop", "senha123")

        b = c.add(url="https://zed.dev", title="Zed", tags="#editor #rust", category="@dev", folder="/ferramentas/")
        self.assertEqual(b["tags"], "editor,rust")
        self.assertEqual(b["category"], "dev")
        self.assertEqual(b["folder"], "ferramentas")

        # Searching already works before any network.
        self.assertEqual(titles(search(c.all_bookmarks(), "#rust")), ["Zed"])

        c.sync()
        pendentes = c.db.execute("SELECT COUNT(*) n FROM bookmarks WHERE dirty = 1").fetchone()["n"]
        self.assertEqual(pendentes, 0, "apos o sync nada fica pendente")

    def test_04_another_client_receives_it(self):
        b = self.make_client("b")
        b.login("desktop", "senha123")
        b.sync()
        self.assertEqual(titles(search(b.all_bookmarks(), "zed")), ["Zed"])
        self.assertEqual(titles(search(b.all_bookmarks(), "@dev")), ["Zed"])

    def test_05_edits_propagate_both_ways(self):
        a = self.make_client("a")
        a.login("desktop", "senha123")
        a.sync()
        item = search(a.all_bookmarks(), "zed")[0]
        a.update(item["id"], title="Zed Editor", tags="editor,rust,ide")
        a.sync()

        b = self.make_client("b")
        b.login("desktop", "senha123")
        b.sync()
        self.assertEqual(titles(search(b.all_bookmarks(), "#ide")), ["Zed Editor"])

    def test_06_deletion_propagates(self):
        a = self.make_client("a")
        a.login("desktop", "senha123")
        a.sync()
        item = search(a.all_bookmarks(), "zed")[0]
        a.delete(item["id"])
        a.sync()

        b = self.make_client("b")
        b.login("desktop", "senha123")
        b.sync()
        self.assertEqual(search(b.all_bookmarks(), "zed"), [], "exclusao no desktop some no other cliente")

    def test_07_created_on_the_web_shows_on_the_desktop(self):
        a = self.make_client("a")
        a.login("desktop", "senha123")
        req = urllib.request.Request(
            self.base + "/api/bookmarks",
            data=json.dumps({"url": "https://news.ycombinator.com", "title": "Hacker News",
                             "tags": "noticias", "category": "news"}).encode(),
            headers={"content-type": "application/json", "authorization": "Bearer " + a.config["token"]},
        )
        urllib.request.urlopen(req)

        a.sync()
        self.assertEqual(titles(search(a.all_bookmarks(), "@news")), ["Hacker News"])

    def test_08_sync_without_server_fails_but_the_cache_works(self):
        c = self.make_client("offline")
        c.login("desktop", "senha123")
        c.sync()
        antes = len(c.all_bookmarks())

        c.config["server"] = "http://127.0.0.1:1"  # porta morta
        c.add(url="https://offline.com", title="Offline")
        with self.assertRaises(ApiError):
            c.sync()

        # Local search keeps working and the pending item is there.
        self.assertEqual(titles(search(c.all_bookmarks(), "offline")), ["Offline"])
        self.assertEqual(len(c.all_bookmarks()), antes + 1)
        pendentes = c.db.execute("SELECT COUNT(*) n FROM bookmarks WHERE dirty = 1").fetchone()["n"]
        self.assertEqual(pendentes, 1, "fica pendente pra empurrar quando voltar")

        # With the network back, the pending one goes up.
        c.config["server"] = self.base
        c.sync()
        d = self.make_client("d")
        d.login("desktop", "senha123")
        d.sync()
        self.assertEqual(titles(search(d.all_bookmarks(), "offline")), ["Offline"])

    def test_09_local_edit_is_not_overwritten_by_the_server(self):
        """Edited offline while the server had an older version: the local one wins."""
        a = self.make_client("conflito-a")
        a.login("desktop", "senha123")
        a.sync()

        item = search(a.all_bookmarks(), "offline")[0]
        a.update(item["id"], title="Offline Editado Localmente")
        # Without syncing: the row is dirty and newer than the server one.
        a.sync()
        self.assertEqual(titles(search(a.all_bookmarks(), "offline")), ["Offline Editado Localmente"])

    def test_10_invalid_token_is_rejected(self):
        c = self.make_client("ruim")
        c.config["token"] = "lixo"
        with self.assertRaises(ApiError):
            c.sync()

    def test_11_full_bar_against_a_real_server(self):
        """BarCore wired to the real Client: add, search, delete."""
        c = self.make_client("bar")
        c.login("desktop", "senha123")
        c.sync()

        core = BarCore(c)
        core.set_query("+ https://caddyserver.com Caddy #tls #proxy @infra")
        acao, bookmark = core.activate()
        self.assertEqual(acao, ADDED)

        c.sync()
        core.refresh()
        core.set_query("#tls")
        self.assertEqual([r.title for r in core.rows], ["Caddy"])

        other = self.make_client("bar-2")
        other.login("desktop", "senha123")
        other.sync()
        self.assertEqual(titles(search(other.all_bookmarks(), "#proxy")), ["Caddy"])

        core.delete_selected()
        c.sync()
        other.sync()
        self.assertEqual(search(other.all_bookmarks(), "#tls"), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
