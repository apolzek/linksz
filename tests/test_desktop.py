#!/usr/bin/env python3
"""Testes do lado desktop.

Cobre, sem precisar de display:
  - o motor de busca em Python e sua paridade com o JS
  - o nucleo da barra (BarCore), que e o que GTK e Tk compartilham
  - a camada de plataforma (caminhos e comandos de Linux vs macOS)
  - a instancia unica por socket, que faz o atalho global acordar a barra
  - o fluxo real contra o servidor Node: offline, sync, dois clientes

O que fica de fora: o desenho em si (widgets GTK/Tk). A view Tk e exercitada
com um tkinter falso em TestViewTk, o que valida o roteamento de teclas.
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

# Isola config/cache/socket dos testes do que existe na maquina.
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
    {"id": "5", "title": "Página com Acentuação", "url": "https://exemplo.com/pagina", "folder": "",
     "category": "work", "tags": "golanguage", "description": "", "updated_at": 1, "deleted": 0},
    {"id": "6", "title": "Excluido", "url": "https://excluido.com", "folder": "", "category": "",
     "tags": "", "description": "", "updated_at": 9, "deleted": 1},
]


def titles(rows):
    return [r["title"] for r in rows]


def t(query, limit=50):
    return titles(search(FIXTURES, query, limit))


class TestBuscaSubstring(unittest.TestCase):
    def test_substring_em_qualquer_posicao(self):
        self.assertEqual(t("kuber"), ["Kubernetes Docs"])
        self.assertEqual(t("bernet"), ["Kubernetes Docs"])
        self.assertEqual(t("ycombinator"), ["Hacker News"])
        self.assertEqual(t("diaria"), ["Hacker News"])

    def test_case_insensitive(self):
        self.assertEqual(t("BERNET"), ["Kubernetes Docs"])
        self.assertEqual(t("KuBeRnEtEs"), ["Kubernetes Docs"])

    def test_ignora_acentos_nos_dois_sentidos(self):
        self.assertEqual(t("acentuacao"), ["Página com Acentuação"])
        self.assertEqual(t("Acentuação"), ["Página com Acentuação"])
        self.assertEqual(t("PAGINA"), ["Página com Acentuação"])

    def test_caracteres_especiais_sao_literais(self):
        self.assertEqual(t("go.dev"), ["The Go Blog"])
        self.assertEqual(t(".*"), [], "nao pode ser tratado como regex")
        self.assertEqual(t("["), [])
        self.assertEqual(t("kubernetes.io/docs"), ["Kubernetes Docs"])


class TestBuscaPorCampo(unittest.TestCase):
    def test_tag(self):
        self.assertEqual(sorted(t("#devops")), ["Grafana", "Kubernetes Docs"])
        self.assertEqual(t("#k8s"), ["Kubernetes Docs"])
        self.assertEqual(t("#inexistente"), [])
        self.assertEqual(t("#Hacker"), [], "titulo nao entra na busca por tag")

    def test_categoria(self):
        self.assertEqual(sorted(t("@studies")), ["Kubernetes Docs", "The Go Blog"])
        self.assertEqual(sorted(t("@stud")), ["Kubernetes Docs", "The Go Blog"])
        self.assertEqual(t("@grafana"), [])

    def test_pasta_pai_casa_filhas(self):
        self.assertEqual(sorted(t("/dev/infra")), ["Grafana", "Kubernetes Docs"])
        self.assertEqual(len(t("/dev")), 3)

    def test_campo_valor(self):
        self.assertEqual(t("title:go"), ["The Go Blog"])
        self.assertEqual(t("url:ycombinator"), ["Hacker News"])
        self.assertEqual(t("description:diaria"), ["Hacker News"])
        self.assertEqual(sorted(t("cat:work")), ["Grafana", "Página com Acentuação"])
        self.assertEqual(t("title:grafana.com"), [], "url nao casa quando o campo e title")

    def test_url_nao_vira_campo_valor(self):
        self.assertEqual(len(t("https://")), 5)
        self.assertEqual(parse_query("https://go.dev")[0].field, "any")


class TestBuscaFrasesENegacao(unittest.TestCase):
    def test_frase_entre_aspas(self):
        self.assertEqual(t('"hacker news"'), ["Hacker News"])
        self.assertEqual(t('"news hacker"'), [], "ordem importa dentro da frase")
        self.assertEqual(t("hacker news"), ["Hacker News"], "sem aspas sao dois termos com AND")
        self.assertEqual(t('title:"go blog"'), ["The Go Blog"])

    def test_aspas_simples_tambem_valem(self):
        self.assertEqual(t("'hacker news'"), ["Hacker News"])

    def test_negacao(self):
        self.assertEqual(t("#devops -#k8s"), ["Grafana"])
        self.assertEqual(t("/dev -@studies"), ["Grafana"])
        self.assertEqual(t("#devops -grafana"), ["Kubernetes Docs"])
        self.assertEqual(t("#devops -#devops"), [])

    def test_so_negacao_lista_o_resto(self):
        self.assertEqual(len(t("-#devops")), len(t("")) - 2)
        self.assertNotIn("Grafana", t("-#devops"))

    def test_aspas_protegem_hifen(self):
        term = parse_query('"-nao-e-negacao"')[0]
        self.assertFalse(term.negate)
        self.assertEqual(term.value, "-nao-e-negacao")


class TestRanking(unittest.TestCase):
    def test_tag_exata_acima_de_substring(self):
        self.assertEqual(t("#go")[0], "The Go Blog")
        self.assertIn("Página com Acentuação", t("#go"))

    def test_titulo_pesa_mais_que_notas(self):
        itens = [
            {"id": "a", "title": "nada", "description": "zebra", "updated_at": 2},
            {"id": "b", "title": "zebra", "description": "", "updated_at": 1},
        ]
        self.assertEqual([b["id"] for b in search(itens, "zebra")], ["b", "a"])

    def test_empate_desempata_pelo_mais_recente(self):
        itens = [
            {"id": "velho", "title": "igual", "updated_at": 1},
            {"id": "novo", "title": "igual", "updated_at": 9},
        ]
        self.assertEqual([b["id"] for b in search(itens, "igual")], ["novo", "velho"])

    def test_updated_at_ausente_ou_invalido(self):
        itens = [
            {"id": "a", "title": "igual"},
            {"id": "b", "title": "igual", "updated_at": None},
            {"id": "c", "title": "igual", "updated_at": "lixo"},
        ]
        self.assertEqual(len(search(itens, "igual")), 3)


class TestParserEBordas(unittest.TestCase):
    def test_tokenize(self):
        self.assertEqual(tokenize("a b  c"), ["a", "b", "c"])
        self.assertEqual(tokenize('"duas palavras" solta'), ['"duas palavras"', "solta"])
        self.assertEqual(tokenize("   "), [])
        self.assertEqual(tokenize(None), [])

    def test_tokenize_aspas_nao_fechadas(self):
        self.assertEqual(tokenize('"sem fechar'), ['"sem fechar'])
        self.assertEqual(parse_query('"sem fechar')[0].value, "sem fechar")

    def test_parse_query_sigilos(self):
        self.assertEqual(parse_query("#a @b /c livre"),
                         [("tags", "a", False), ("category", "b", False),
                          ("folder", "c", False), ("any", "livre", False)])

    def test_parse_query_apelidos_de_campo(self):
        for texto, campo in (("title:x", "title"), ("link:x", "url"), ("note:x", "description"),
                             ("tag:x", "tags"), ("cat:x", "category"), ("dir:x", "folder"),
                             ("TITLE:x", "title")):
            self.assertEqual(parse_query(texto)[0].field, campo, texto)

    def test_sigilo_sozinho_e_ignorado(self):
        # Digitar "#" a caminho de "#devops" nao pode esvaziar a lista.
        for q in ("#", "@", "/", "-", '""', "''", "  ", ""):
            self.assertEqual(parse_query(q), [], repr(q))
        self.assertEqual(t("#"), t(""))

    def test_excluidos_nunca_aparecem(self):
        self.assertNotIn("Excluido", t(""))
        self.assertEqual(t("excluido.com"), [])

    def test_limite(self):
        self.assertEqual(len(t("", limit=2)), 2)
        self.assertEqual(len(t("", limit=0)), 0)

    def test_lista_vazia_e_campos_ausentes(self):
        self.assertEqual(search([], "x"), [])
        self.assertEqual(len(search([{"id": "x"}], "")), 1)
        self.assertEqual(search([{"id": "x"}], "qualquer"), [])

    def test_components(self):
        self.assertEqual(components("a,b c"), ["a", "b", "c"])
        self.assertEqual(components(""), [])


class TestParidadeComJS(unittest.TestCase):
    """A barra (Python) e a web (JS) precisam responder identico a mesma query.

    Sao dois motores escritos na mao em linguagens diferentes; sem este teste
    a divergencia aparece so quando o usuario busca a mesma coisa nos dois
    lugares e ve resultados diferentes.
    """

    QUERIES = [
        "", "   ", "kuber", "BERNET", "ycombinator", "go.dev", "#devops", "#go",
        "@studies", "@stud", "/dev", "/dev/infra", "#devops @work", "acentuacao",
        "pagina", "diaria", "inexistente", "https://", "#k8s @studies /dev/infra",
        # sintaxe avancada
        '"hacker news"', '"news hacker"', "'aspas simples'", 'title:"go blog"',
        "title:go", "url:ycombinator", "description:diaria", "cat:work", "dir:dev",
        "-grafana", "#devops -#k8s", "/dev -@studies", "-#devops", '-"hacker news"',
        "#devops -#devops", "foo:bar", "TITLE:go",
        # bordas
        "#", "@", "/", "-", '""', '"', "-#", "//", "@@", ".*", "[", "a b c",
        "  espaco  duplo  ", "ÁÉÍ", " nbsp", "x﻿y",
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

    def test_queries_conhecidas(self):
        esperado = self.run_js(FIXTURES, self.QUERIES)
        for query, js_ids in zip(self.QUERIES, esperado):
            py_ids = [b["id"] for b in search(FIXTURES, query, 50)]
            self.assertEqual(py_ids, js_ids, f"divergencia na query {query!r}")

    def test_fuzz(self):
        """Gera queries e acervos aleatorios — pega o que a lista fixa nao cobre."""
        rnd = random.Random(20260813)
        palavras = ["kuber", "go", "golang", "dev", "infra", "news", "café", "Ação",
                    "web dev", "k8s", "devops", "a,b", "https://x.com", "TÍTULO", "", "ícone"]
        sigilos = ["", "#", "@", "/", "-", "-#", "-@", '"', "title:", "tag:", "cat:",
                   "folder:", "url:", "description:", "https:", "-title:"]

        acervo = [{
            "id": str(i),
            "title": rnd.choice(palavras), "url": rnd.choice(palavras),
            "folder": rnd.choice(palavras), "category": rnd.choice(palavras),
            "tags": ",".join(rnd.sample(palavras, k=rnd.randint(0, 3))),
            "description": rnd.choice(palavras),
            "updated_at": rnd.choice([rnd.randint(0, 100), None, 0]),
            "deleted": rnd.choice([0, 0, 0, 1]),
        } for i in range(30)]

        queries = []
        for _ in range(250):
            partes = []
            for _ in range(rnd.randint(1, 3)):
                palavra = rnd.choice(palavras)
                if " " in palavra and rnd.random() < 0.7:
                    palavra = f'"{palavra}"'
                partes.append(rnd.choice(sigilos) + palavra)
            queries.append(" ".join(partes))

        esperado = self.run_js(acervo, queries)
        for query, js_ids in zip(queries, esperado):
            py_ids = [b["id"] for b in search(acervo, query, 50)]
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

    def test_quick_add_infere_https(self):
        self.assertEqual(parse_quick_add("go.dev #go")["url"], "https://go.dev")

    def test_quick_add_sem_url(self):
        p = parse_quick_add("so um titulo #tag")
        self.assertEqual(p["url"], "")
        self.assertEqual(p["title"], "so um titulo")


class TestPlataforma(unittest.TestCase):
    """Linux e macOS diferem em caminho e em como se abre uma URL."""

    def test_caminhos_respeitam_xdg(self):
        self.assertTrue(vmplatform.config_dir().startswith(_SANDBOX))
        self.assertTrue(vmplatform.data_dir().startswith(_SANDBOX))
        self.assertTrue(vmplatform.config_dir().endswith("vaultmarks"))

    def test_caminhos_macos(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(vmplatform, "IS_MAC", True):
            self.assertIn("Library/Application Support", vmplatform.config_dir())
            self.assertIn("Library/Application Support", vmplatform.data_dir())

    def test_caminhos_linux(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(vmplatform, "IS_MAC", False):
            self.assertIn(".config", vmplatform.config_dir())
            self.assertIn(".local/share", vmplatform.data_dir())

    def test_open_url_por_sistema(self):
        with mock.patch.object(vmplatform, "IS_MAC", True):
            self.assertEqual(vmplatform.open_url_command("https://go.dev"), ["open", "https://go.dev"])
        with mock.patch.object(vmplatform, "IS_MAC", False):
            self.assertEqual(vmplatform.open_url_command("https://go.dev"), ["xdg-open", "https://go.dev"])

    def test_open_url_completa_esquema(self):
        cmd = vmplatform.open_url_command("go.dev")
        self.assertEqual(cmd[-1], "https://go.dev")
        self.assertIsNone(vmplatform.open_url_command(""))

    def test_socket_fica_em_diretorio_privado(self):
        caminho = vmplatform.socket_path()
        modo = os.stat(os.path.dirname(caminho)).st_mode & 0o777
        self.assertEqual(modo, 0o700, "socket nao pode ficar em diretorio aberto")

    def test_toolkit_pode_ser_forcado(self):
        with mock.patch.dict(os.environ, {"VAULTMARKS_UI": "tk"}):
            self.assertEqual(vmplatform.pick_toolkit(), "tk")
        with mock.patch.dict(os.environ, {"VAULTMARKS_UI": "gtk"}):
            self.assertEqual(vmplatform.pick_toolkit(), "gtk")

    def test_sem_toolkit_da_erro_util(self):
        with mock.patch.dict(os.environ, {"VAULTMARKS_UI": ""}), \
             mock.patch.object(vmplatform, "available_toolkits", return_value=[]):
            with self.assertRaises(RuntimeError) as ctx:
                vmplatform.pick_toolkit()
            self.assertIn("instale", str(ctx.exception).lower())

    def test_macos_prefere_tk(self):
        """No macOS o Tk vem com o Python; GTK praticamente nunca existe."""
        with mock.patch.object(vmplatform, "IS_MAC", True):
            with mock.patch.dict(sys.modules, {"tkinter": mock.MagicMock()}):
                self.assertEqual(vmplatform.available_toolkits()[0], "tk")


class TestIPCInstanciaUnica(unittest.TestCase):
    """O atalho global roda o script de novo; ele so acorda o daemon."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vm-ipc-")
        self.path = os.path.join(self.dir, "bar.sock")
        self.recebidas = []

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_send_sem_daemon_falha(self):
        self.assertFalse(vmipc.send(self.path, vmipc.SHOW))
        self.assertFalse(vmipc.is_running(self.path))

    def test_daemon_recebe_mensagens(self):
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

    def test_ping_nao_vira_mensagem(self):
        listener = vmipc.Listener(self.path, self.recebidas.append).start()
        try:
            vmipc.is_running(self.path)
            time.sleep(0.15)
            self.assertEqual(self.recebidas, [], "ping so checa se esta vivo")
        finally:
            listener.close()

    def test_dois_daemons_nao_coexistem(self):
        listener = vmipc.Listener(self.path, self.recebidas.append).start()
        try:
            with self.assertRaises(OSError):
                vmipc.Listener(self.path, self.recebidas.append).start()
        finally:
            listener.close()

    def test_socket_orfao_e_reassumido(self):
        """Daemon morto sem limpar deixa o arquivo; o proximo precisa assumir."""
        open(self.path, "w").close()
        listener = vmipc.Listener(self.path, self.recebidas.append).start()
        try:
            self.assertTrue(vmipc.send(self.path, vmipc.SHOW))
        finally:
            listener.close()

    def test_close_remove_o_socket(self):
        listener = vmipc.Listener(self.path, self.recebidas.append).start()
        listener.close()
        self.assertFalse(os.path.exists(self.path))


class FakeClient:
    """Cliente em memoria: BarCore so precisa destes quatro metodos."""

    def __init__(self, items=None):
        # Copia profunda: delete() marca deleted=1 no dict, e sem isso um teste
        # sujaria as FIXTURES globais para todos os que rodam depois.
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
    """O nucleo que GTK e Tk compartilham — tudo que a barra decide esta aqui."""

    def setUp(self):
        self.client = FakeClient(FIXTURES)
        self.core = BarCore(self.client)

    def test_lista_tudo_sem_query(self):
        self.assertEqual(len(self.core.rows), 5)
        self.assertEqual(self.core.total, 5)
        self.assertIn("5 bookmarks", self.core.status())

    def test_busca_filtra(self):
        self.core.set_query("kuber")
        self.assertEqual([r.title for r in self.core.rows], ["Kubernetes Docs"])
        self.assertIn("1 of 5", self.core.status())

    def test_busca_avancada_chega_na_barra(self):
        self.core.set_query("#devops -#k8s")
        self.assertEqual([r.title for r in self.core.rows], ["Grafana"])
        self.core.set_query('"hacker news"')
        self.assertEqual([r.title for r in self.core.rows], ["Hacker News"])

    def test_sem_resultado_sugere_adicionar(self):
        self.core.set_query("naoexiste")
        self.assertEqual(self.core.rows, [])
        self.assertIn("+ naoexiste", self.core.status())

    def test_linha_traz_titulo_url_e_badges(self):
        self.core.set_query("kuber")
        row = self.core.rows[0]
        self.assertEqual(row.kind, "result")
        self.assertEqual(row.subtitle, "https://kubernetes.io/docs")
        self.assertEqual(row.badges,
                         [("folder", "/dev/infra"), ("cat", "@studies"),
                          ("tag", "#k8s"), ("tag", "#devops")])

    def test_titulo_cai_pra_url_quando_falta(self):
        core = BarCore(FakeClient([{"id": "x", "url": "https://so-url.com", "title": ""}]))
        self.assertEqual(core.rows[0].title, "https://so-url.com")

    def test_navegacao_respeita_limites(self):
        self.assertEqual(self.core.sel, 0)
        self.assertEqual(self.core.move(-1), 0, "nao passa do topo")
        self.core.move(1)
        self.assertEqual(self.core.sel, 1)
        self.core.move(50)
        self.assertEqual(self.core.sel, 4, "nao passa do fim")

    def test_navegacao_com_lista_vazia(self):
        self.core.set_query("naoexiste")
        self.assertEqual(self.core.move(1), 0)
        self.assertIsNone(self.core.selected())

    def test_busca_reseta_selecao(self):
        self.core.move(3)
        self.core.set_query("kuber")
        self.assertEqual(self.core.sel, 0)

    def test_enter_abre_a_url(self):
        self.core.set_query("kuber")
        self.assertEqual(self.core.activate(), (OPEN, "https://kubernetes.io/docs"))

    def test_enter_sem_linha_nao_faz_nada(self):
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

    def test_quick_add_vazio_reclama(self):
        self.core.set_query("+   ")
        acao, msg = self.core.activate()
        self.assertEqual(acao, ERROR)
        self.assertIn("url", msg)
        self.assertEqual(self.client.added, [])

    def test_copiar(self):
        self.core.set_query("kuber")
        self.assertEqual(self.core.copy_selected(), "https://kubernetes.io/docs")
        self.assertIn("copied", self.core.status())

    def test_copiar_na_linha_de_add_nao_faz_nada(self):
        self.core.set_query("+ algo")
        self.assertIsNone(self.core.copy_selected())

    def test_remover(self):
        self.core.set_query("kuber")
        removido = self.core.delete_selected()
        self.assertEqual(removido["id"], "1")
        self.assertEqual(self.client.deleted, ["1"])
        self.assertEqual(self.core.rows, [], "some da lista na hora")
        self.assertIn("deleted", self.core.status())

    def test_remover_ajusta_selecao(self):
        self.core.move(4)          # ultima linha
        self.core.delete_selected()
        self.assertEqual(self.core.sel, 3, "selecao nao pode ficar fora da lista")

    def test_sync_com_erro_avisa_e_mantem_cache(self):
        mudou = self.core.on_sync_result(0, "servidor inacessivel")
        self.assertTrue(mudou)
        self.assertIn("offline", self.core.status())
        self.assertEqual(len(self.core.rows), 5, "continua listando do cache")

    def test_sync_sem_novidade_nao_redesenha(self):
        self.assertFalse(self.core.on_sync_result(0, None))

    def test_sync_com_novidade_preserva_a_busca(self):
        self.core.set_query("kuber")
        self.client.items.append({"id": "9", "title": "Kubernetes Extra", "url": "https://k.io",
                                  "tags": "", "category": "", "folder": "", "updated_at": 50})
        self.assertTrue(self.core.on_sync_result(1, None))
        self.assertEqual(self.core.query, "kuber", "a busca digitada nao pode sumir")
        self.assertEqual(len(self.core.rows), 2)


class TestViewTk(unittest.TestCase):
    """Caminho do macOS: valida o roteamento de teclas da view Tk.

    tkinter nao esta instalado em toda maquina de CI (e nao ha display aqui),
    entao trocamos por um duble. Nao valida o desenho — valida que cada tecla
    chama a acao certa no nucleo, que e onde a logica mora.
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

    def test_setas_navegam(self):
        bar, _ = self._bar()
        bar.on_key(self._evento("Down"))
        self.assertEqual(bar.core.sel, 1)
        bar.on_key(self._evento("Up"))
        self.assertEqual(bar.core.sel, 0)

    def test_control_n_e_p_navegam(self):
        bar, _ = self._bar()
        bar.on_key(self._evento("n", state=0x4))     # Control
        self.assertEqual(bar.core.sel, 1)
        bar.on_key(self._evento("p", state=0x4))
        self.assertEqual(bar.core.sel, 0)

    def test_command_navega_no_macos(self):
        bar, _ = self._bar()
        bar.on_key(self._evento("n", state=0x8))     # Command
        self.assertEqual(bar.core.sel, 1, "no Mac o modificador natural e Command")

    def test_escape_limpa_depois_fecha(self):
        bar, _ = self._bar()
        bar.var.get.return_value = "algo"
        bar.on_key(self._evento("Escape"))
        bar.var.set.assert_called_with("")
        bar.hide.assert_not_called()

        bar.var.get.return_value = ""
        bar.on_key(self._evento("Escape"))
        bar.hide.assert_called_once()

    def test_enter_abre_e_esconde(self):
        bar, vmbar_tk = self._bar()
        with mock.patch.object(vmbar_tk.vmplatform, "open_url") as abrir:
            bar.on_key(self._evento("Return"))
            abrir.assert_called_once()
            self.assertTrue(abrir.call_args[0][0].startswith("http"))
        bar.hide.assert_called_once()

    def test_ctrl_c_copia_para_o_clipboard(self):
        bar, _ = self._bar()
        bar.on_key(self._evento("c", state=0x4))
        bar.root.clipboard_clear.assert_called_once()
        bar.root.clipboard_append.assert_called_once()

    def test_ctrl_d_remove(self):
        bar, _ = self._bar()
        alvo = bar.core.rows[0].bookmark["id"]
        bar.on_key(self._evento("d", state=0x4))
        self.assertEqual(bar.client.deleted, [alvo])
        bar.sync_async.assert_called_once()

    def test_ctrl_r_sincroniza(self):
        bar, _ = self._bar()
        bar.on_key(self._evento("r", state=0x4))
        bar.sync_async.assert_called_once()

    def test_tecla_desconhecida_passa_adiante(self):
        bar, _ = self._bar()
        self.assertIsNone(bar.on_key(self._evento("a")), "digitar letra tem que chegar no campo")

    def test_teclas_tratadas_nao_propagam(self):
        bar, _ = self._bar()
        self.assertEqual(bar.on_key(self._evento("Down")), "break")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class TestSyncComServidor(unittest.TestCase):
    """Fluxo real contra o servidor Node: escrever offline, sincronizar, convergir."""

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
            raise RuntimeError("servidor nao subiu")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def make_client(self, name):
        """Cliente com config+cache proprios (simula outra maquina)."""
        d = os.path.join(self.tmp, name)
        os.makedirs(d, exist_ok=True)
        c = Client(config_path=os.path.join(d, "config.json"), cache_path=os.path.join(d, "cache.db"))
        c.config["server"] = self.base
        return c

    def test_01_registro_e_login(self):
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

    def test_02_token_fica_com_permissao_restrita(self):
        c = self.make_client("perm")
        c.login("desktop", "senha123")
        modo = os.stat(c.config_path).st_mode & 0o777
        self.assertEqual(modo, 0o600, "o token de sessao nao pode ficar legivel pra todos")

    def test_03_add_offline_depois_sincroniza(self):
        c = self.make_client("a")
        c.login("desktop", "senha123")

        b = c.add(url="https://zed.dev", title="Zed", tags="#editor #rust", category="@dev", folder="/ferramentas/")
        self.assertEqual(b["tags"], "editor,rust")
        self.assertEqual(b["category"], "dev")
        self.assertEqual(b["folder"], "ferramentas")

        # Ja da pra buscar antes de qualquer rede.
        self.assertEqual(titles(search(c.all_bookmarks(), "#rust")), ["Zed"])

        c.sync()
        pendentes = c.db.execute("SELECT COUNT(*) n FROM bookmarks WHERE dirty = 1").fetchone()["n"]
        self.assertEqual(pendentes, 0, "apos o sync nada fica pendente")

    def test_04_outro_cliente_recebe(self):
        b = self.make_client("b")
        b.login("desktop", "senha123")
        b.sync()
        self.assertEqual(titles(search(b.all_bookmarks(), "zed")), ["Zed"])
        self.assertEqual(titles(search(b.all_bookmarks(), "@dev")), ["Zed"])

    def test_05_edicao_propaga_nos_dois_sentidos(self):
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

    def test_06_exclusao_propaga(self):
        a = self.make_client("a")
        a.login("desktop", "senha123")
        a.sync()
        item = search(a.all_bookmarks(), "zed")[0]
        a.delete(item["id"])
        a.sync()

        b = self.make_client("b")
        b.login("desktop", "senha123")
        b.sync()
        self.assertEqual(search(b.all_bookmarks(), "zed"), [], "exclusao no desktop some no outro cliente")

    def test_07_criado_na_web_aparece_no_desktop(self):
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

    def test_08_sync_sem_servidor_falha_mas_cache_funciona(self):
        c = self.make_client("offline")
        c.login("desktop", "senha123")
        c.sync()
        antes = len(c.all_bookmarks())

        c.config["server"] = "http://127.0.0.1:1"  # porta morta
        c.add(url="https://offline.com", title="Offline")
        with self.assertRaises(ApiError):
            c.sync()

        # Busca local continua funcionando e o item pendente esta la.
        self.assertEqual(titles(search(c.all_bookmarks(), "offline")), ["Offline"])
        self.assertEqual(len(c.all_bookmarks()), antes + 1)
        pendentes = c.db.execute("SELECT COUNT(*) n FROM bookmarks WHERE dirty = 1").fetchone()["n"]
        self.assertEqual(pendentes, 1, "fica pendente pra empurrar quando voltar")

        # Voltando a rede, o pendente sobe.
        c.config["server"] = self.base
        c.sync()
        d = self.make_client("d")
        d.login("desktop", "senha123")
        d.sync()
        self.assertEqual(titles(search(d.all_bookmarks(), "offline")), ["Offline"])

    def test_09_edicao_local_nao_e_sobrescrita_pelo_servidor(self):
        """Editou offline e o servidor tinha versao mais velha: a local vence."""
        a = self.make_client("conflito-a")
        a.login("desktop", "senha123")
        a.sync()

        item = search(a.all_bookmarks(), "offline")[0]
        a.update(item["id"], title="Offline Editado Localmente")
        # Sem sincronizar: o registro esta sujo e mais novo que o do servidor.
        a.sync()
        self.assertEqual(titles(search(a.all_bookmarks(), "offline")), ["Offline Editado Localmente"])

    def test_10_token_invalido_e_rejeitado(self):
        c = self.make_client("ruim")
        c.config["token"] = "lixo"
        with self.assertRaises(ApiError):
            c.sync()

    def test_11_barra_completa_contra_servidor_real(self):
        """BarCore ligado no Client de verdade: adicionar, buscar, remover."""
        c = self.make_client("barra")
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

        outro = self.make_client("barra-2")
        outro.login("desktop", "senha123")
        outro.sync()
        self.assertEqual(titles(search(outro.all_bookmarks(), "#proxy")), ["Caddy"])

        core.delete_selected()
        c.sync()
        outro.sync()
        self.assertEqual(search(outro.all_bookmarks(), "#tls"), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
