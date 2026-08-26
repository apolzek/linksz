#!/usr/bin/env python3
"""Is the YAML we write real YAML?

api/yaml.js is hand-written (the backend has no dependencies). A home-made
parser risks speaking a private dialect: it reads back what it wrote and nobody
else understands it, exactly the opposite of what an export format should be.

These tests check the implementation against PyYAML in both directions:

    our emitter -> PyYAML   the exported file opens in any tool
    PyYAML -> our parser    a file from another tool imports here

They are skipped when PyYAML is not installed: it is not a dependency of the
project, only the second opinion.
"""

import json
import os
import random
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
YAML_JS = os.path.join(ROOT, "api", "yaml.js")

try:
    import yaml as pyyaml
except ImportError:
    pyyaml = None


def node(script, payload):
    proc = subprocess.run(
        ["node", "-e", script, YAML_JS],
        input=json.dumps(payload), capture_output=True, text=True, check=True,
    )
    return json.loads(proc.stdout)


def js_stringify(docs):
    return node("""
      const Y = require(process.argv[1]);
      const docs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      console.log(JSON.stringify(docs.map((d) => Y.stringify(d))));
    """, docs)


def js_parse(texts):
    return node("""
      const Y = require(process.argv[1]);
      const docs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      console.log(JSON.stringify(docs.map((t) => {
        try { return { ok: Y.parse(t) }; } catch (e) { return { error: e.message }; }
      })));
    """, texts)


# Every one of these has broken some version of the implementation.
PIECES = [
    "plain", "with: a colon", "with 'quotes'", 'with "doubles"', "line1\nline2",
    "  space at the edges  ", "🔖 emoji", "café com acento", "-starts with a dash",
    "007", "yes", "true", "", "#hash", "a,b", "quite long text " * 12,
    "tab\tin the middle", "back\\slash", "ends with a space ", "[bracket]", "{brace}",
    "url: https://x.com/#a", "stray ' quote", 'stray " quote', "braces {a: 1} in the middle",
    "comma, in the middle", "slash at the end \\", "two \\\\ slashes", "* asterisk", "& ampersand",
]

URLS = ["https://x.com/#anchor", "http://y.org?q=1&b=2", "", "https://a.io/p/1"]


def generate(rnd):
    return {
        "id": str(rnd.randint(1, 9999)),
        "title": rnd.choice(PIECES),
        "url": rnd.choice(URLS),
        "folder": rnd.choice(["", "dev", "dev/infra", "with a space"]),
        "category": rnd.choice(["", "work", "studies"]),
        "tags": rnd.sample(["go", "cli", "k8s", "devops"], k=rnd.randint(0, 4)),
        "description": rnd.choice(PIECES),
        "created_at": rnd.randint(0, 10 ** 13),
        "updated_at": rnd.randint(0, 10 ** 13),
        "deleted": rnd.choice([0, 1]),
    }


@unittest.skipIf(pyyaml is None, "PyYAML not installed, interoperability test skipped")
class TestInteropWithPyYAML(unittest.TestCase):
    COUNT = 250

    @classmethod
    def setUpClass(cls):
        rnd = random.Random(20260813)
        cls.docs = [generate(rnd) for _ in range(cls.COUNT)]
        # Also the real export shape: a mapping with a list of bookmarks inside.
        cls.docs += [
            {"version": 1, "count": n, "bookmarks": [generate(rnd) for _ in range(rnd.randint(0, 4))]}
            for n in range(50)
        ]

    def test_what_we_write_pyyaml_reads(self):
        """An export opens in any YAML tool."""
        for doc, text in zip(self.docs, js_stringify(self.docs)):
            try:
                parsed = pyyaml.safe_load(text)
            except Exception as err:  # noqa: BLE001, any failure here is a test failure
                self.fail(f"PyYAML could not read what we emitted: {err}\n{text}")
            self.assertEqual(parsed, doc, f"PyYAML read it differently:\n{text}")

    def test_what_pyyaml_writes_we_read(self):
        """A file coming from another tool imports here.

        The style varies on purpose: block and flow, wide and narrow lines. That
        is what changes between emitters and where a home-made parser usually
        breaks.
        """
        texts = [
            pyyaml.dump(doc, allow_unicode=True, sort_keys=False,
                        default_flow_style=(i % 3 == 0), width=(40 if i % 2 else 200))
            for i, doc in enumerate(self.docs)
        ]
        for doc, text, result in zip(self.docs, texts, js_parse(texts)):
            self.assertNotIn("error", result, f"could not read:\n{text}\n{result.get('error')}")
            self.assertEqual(result["ok"], doc, f"read differently from PyYAML:\n{text}")

    def test_round_trip_through_both_libraries(self):
        """ours -> PyYAML -> ours preserves the document."""
        ours = js_stringify(self.docs)
        reemitted = [pyyaml.dump(pyyaml.safe_load(t), allow_unicode=True, sort_keys=False) for t in ours]
        for doc, result in zip(self.docs, js_parse(reemitted)):
            self.assertNotIn("error", result, result.get("error"))
            self.assertEqual(result["ok"], doc)


class TestRealExportOpensInPyYAML(unittest.TestCase):
    """The file people download, comment header and all."""

    @unittest.skipIf(pyyaml is None, "PyYAML not installed")
    def test_full_export(self):
        vault = [
            {"id": "a1", "title": "Página com Acentuação", "url": "https://x.com/#a",
             "folder": "dev/infra", "category": "studies", "tags": "go,cli",
             "description": "note with\ntwo lines", "created_at": 1, "updated_at": 2},
            {"id": "a2", "title": "Caddy: server", "url": "", "folder": "", "category": "",
             "tags": "", "description": "", "created_at": 3, "updated_at": 4},
        ]
        text = node("""
          const p = require(require('path').join(require('path').dirname(process.argv[1]), 'portability.js'));
          const vault = JSON.parse(require('fs').readFileSync(0, 'utf8'));
          console.log(JSON.stringify(p.toYaml(vault, { user: 'apolzek' })));
        """, vault)

        doc = pyyaml.safe_load(text)
        self.assertEqual(doc["version"], 2)
        self.assertEqual(doc["count"], 2)
        # Grouped by folder: the path is the key, and what has none is unfiled.
        self.assertEqual(list(doc["folders"]), ["dev/infra"])
        entry = doc["folders"]["dev/infra"][0]
        self.assertEqual(entry["title"], "Página com Acentuação")
        self.assertEqual(entry["tags"], ["go", "cli"])
        self.assertEqual(entry["description"], "note with\ntwo lines")
        self.assertNotIn("folder", entry, "the folder is the key, not a field")
        self.assertEqual([b["title"] for b in doc["unfiled"]], ["Caddy: server"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
