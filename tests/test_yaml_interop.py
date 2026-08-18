#!/usr/bin/env python3
"""O YAML que o Vaultmarks escreve é YAML de verdade?

server/yaml.js é escrito à mão (o backend não tem dependências). Um parser
caseiro corre o risco de falar um dialeto próprio: relê o que ele mesmo
escreveu e ninguém mais entende — exatamente o oposto do que um formato de
export deveria ser.

Estes testes confrontam a implementação com o PyYAML nos dois sentidos:

    meu emissor -> PyYAML   o arquivo exportado abre em qualquer ferramenta
    PyYAML -> meu parser    um arquivo de outra ferramenta importa aqui

São pulados se o PyYAML não estiver instalado — ele não é dependência do
projeto, é só a segunda opinião.
"""

import json
import os
import random
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
YAML_JS = os.path.join(ROOT, "server", "yaml.js")

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


def js_parse(textos):
    return node("""
      const Y = require(process.argv[1]);
      const docs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      console.log(JSON.stringify(docs.map((t) => {
        try { return { ok: Y.parse(t) }; } catch (e) { return { erro: e.message }; }
      })));
    """, textos)


# Cada um destes já quebrou alguma versão da implementação.
PECAS = [
    "simples", "com: dois pontos", "com 'aspas'", 'com "duplas"', "linha1\nlinha2",
    "  espaco nas pontas  ", "🔖 emoji", "café com acento", "-comeca com traco",
    "007", "yes", "true", "", "#hash", "a,b", "texto bem longo " * 12,
    "tab\tno meio", "barra\\invertida", "termina com espaco ", "[colchete]", "{chave}",
    "url: https://x.com/#a", "aspa ' solta", 'aspa " solta', "chaves {a: 1} no meio",
    "virgula, no meio", "barra no fim \\", "dois \\\\ barras", "* asterisco", "& e-comercial",
]

URLS = ["https://x.com/#anchor", "http://y.org?q=1&b=2", "", "https://a.io/p/1"]


def gerar(rnd):
    return {
        "id": str(rnd.randint(1, 9999)),
        "title": rnd.choice(PECAS),
        "url": rnd.choice(URLS),
        "folder": rnd.choice(["", "dev", "dev/infra", "com espaço"]),
        "category": rnd.choice(["", "work", "studies"]),
        "tags": rnd.sample(["go", "cli", "k8s", "devops"], k=rnd.randint(0, 4)),
        "description": rnd.choice(PECAS),
        "created_at": rnd.randint(0, 10 ** 13),
        "updated_at": rnd.randint(0, 10 ** 13),
        "deleted": rnd.choice([0, 1]),
    }


@unittest.skipIf(pyyaml is None, "PyYAML nao instalado — teste de interoperabilidade pulado")
class TestInteropComPyYAML(unittest.TestCase):
    QUANTIDADE = 250

    @classmethod
    def setUpClass(cls):
        rnd = random.Random(20260813)
        cls.docs = [gerar(rnd) for _ in range(cls.QUANTIDADE)]
        # Também o formato real do export: mapa com lista de favoritos dentro.
        cls.docs += [
            {"version": 1, "count": n, "bookmarks": [gerar(rnd) for _ in range(rnd.randint(0, 4))]}
            for n in range(50)
        ]

    def test_o_que_eu_escrevo_o_pyyaml_le(self):
        """Um export do Vaultmarks abre em qualquer ferramenta de YAML."""
        for doc, texto in zip(self.docs, js_stringify(self.docs)):
            try:
                lido = pyyaml.safe_load(texto)
            except Exception as err:  # noqa: BLE001 — qualquer falha aqui é falha do teste
                self.fail(f"PyYAML nao conseguiu ler o que emitimos: {err}\n{texto}")
            self.assertEqual(lido, doc, f"PyYAML leu diferente:\n{texto}")

    def test_o_que_o_pyyaml_escreve_eu_leio(self):
        """Um arquivo vindo de outra ferramenta importa aqui.

        Varia o estilo de propósito: bloco e flow, linha larga e estreita —
        é o que muda entre emissores e onde um parser caseiro costuma quebrar.
        """
        textos = [
            pyyaml.dump(doc, allow_unicode=True, sort_keys=False,
                        default_flow_style=(i % 3 == 0), width=(40 if i % 2 else 200))
            for i, doc in enumerate(self.docs)
        ]
        for doc, texto, resultado in zip(self.docs, textos, js_parse(textos)):
            self.assertNotIn("erro", resultado, f"nao consegui ler:\n{texto}\n{resultado.get('erro')}")
            self.assertEqual(resultado["ok"], doc, f"li diferente do PyYAML:\n{texto}")

    def test_ida_e_volta_pelas_duas_bibliotecas(self):
        """Vaultmarks -> PyYAML -> Vaultmarks preserva o documento."""
        meus = js_stringify(self.docs)
        reemitidos = [pyyaml.dump(pyyaml.safe_load(t), allow_unicode=True, sort_keys=False) for t in meus]
        for doc, resultado in zip(self.docs, js_parse(reemitidos)):
            self.assertNotIn("erro", resultado, resultado.get("erro"))
            self.assertEqual(resultado["ok"], doc)


class TestExportRealAbreNoPyYAML(unittest.TestCase):
    """O arquivo que o usuário baixa — com cabeçalho de comentário e tudo."""

    @unittest.skipIf(pyyaml is None, "PyYAML nao instalado")
    def test_export_completo(self):
        vault = [
            {"id": "a1", "title": "Página com Acentuação", "url": "https://x.com/#a",
             "folder": "dev/infra", "category": "studies", "tags": "go,cli",
             "description": "nota com\nduas linhas", "created_at": 1, "updated_at": 2},
            {"id": "a2", "title": "Caddy: servidor", "url": "", "folder": "", "category": "",
             "tags": "", "description": "", "created_at": 3, "updated_at": 4},
        ]
        texto = node("""
          const p = require(require('path').join(require('path').dirname(process.argv[1]), 'portability.js'));
          const vault = JSON.parse(require('fs').readFileSync(0, 'utf8'));
          console.log(JSON.stringify(p.toYaml(vault, { user: 'apolzek' })));
        """, vault)

        doc = pyyaml.safe_load(texto)
        self.assertEqual(doc["version"], 1)
        self.assertEqual(doc["count"], 2)
        self.assertEqual([b["title"] for b in doc["bookmarks"]],
                         ["Página com Acentuação", "Caddy: servidor"])
        self.assertEqual(doc["bookmarks"][0]["tags"], ["go", "cli"])
        self.assertEqual(doc["bookmarks"][0]["description"], "nota com\nduas linhas")


if __name__ == "__main__":
    unittest.main(verbosity=2)
