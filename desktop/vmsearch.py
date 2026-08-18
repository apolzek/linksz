"""Motor de busca da barra desktop — espelho exato de web/search.js.

Sintaxe:
    texto            substring em titulo, url, tags, categoria, pasta, notas
    "duas palavras"  substring com espaco (frase literal)
    #tag             so em tags
    @categoria       so em categoria
    /pasta           so em pasta
    campo:valor      so no campo (title, url, description, tag/tags, cat/category, folder)
    -termo           exclui (funciona com qualquer forma acima)

Termos combinam com AND. Tudo e substring, case-insensitive e sem acentos.

Qualquer mudanca aqui precisa acontecer tambem em web/search.js:
tests/test_desktop.py roda as duas implementacoes e exige resultado identico.
"""

import re
import unicodedata
from collections import namedtuple

FIELDS = ("title", "url", "tags", "category", "folder", "description")

# Peso de cada campo na busca livre: onde casou importa mais que quantas vezes.
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
    # O campo se chamava `notes`; quem digita `notes:algo` continua achando.
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

# Espaco definido na unha (em vez de /\s/ e isspace()) porque as duas
# linguagens discordam em cantos como U+0085 e U+FEFF — e a paridade
# JS <-> Python precisa valer para qualquer entrada.
WHITESPACE = (
    " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)

FIELD_PREFIX_RE = re.compile(r"^([a-zA-Z]+):(.*)$", re.DOTALL)

# Compara igual a uma tupla (field, value, negate) — conveniente nos testes.
Term = namedtuple("Term", "field value negate")


def norm(s):
    s = "" if s is None else str(s)
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c)).lower()


def tokenize(q):
    """Quebra por espaco, mantendo junto o que estiver entre aspas.

    As aspas seguem no token — quem remove e strip_quotes, depois dos prefixos.
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
    """Quebra um campo em componentes (tags sao csv, titulos tem espaco).

    Escrito na mao pelo mesmo motivo de WHITESPACE: split(/[,\\s]+/) e
    str.split() nao concordam em todos os caracteres.
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
    """Aspas nao fechadas ainda contam: `"foo bar` vira `foo bar`."""
    if s and s[0] in QUOTES:
        q = s[0]
        s = s[1:]
        if s.endswith(q):
            s = s[:-1]
    return s


def parse_token(raw):
    text = raw

    # Sigilo sem valor (`#`, `-`, `@`) vira termo vazio e e descartado por
    # parse_query — enquanto se digita `#devops`, o `#` sozinho nao pode zerar
    # a lista.
    negate = text[:1] == "-"
    if negate:
        text = text[1:]

    field = "any"
    if text[:1] in SIGILS:
        field = SIGILS[text[0]]
        text = text[1:]
    else:
        # `campo:valor` — so para campos conhecidos, senao `https://x` viraria
        # um filtro pelo campo "https".
        m = FIELD_PREFIX_RE.match(text)
        if m and m.group(1).lower() in FIELD_ALIASES:
            field = FIELD_ALIASES[m.group(1).lower()]
            text = m.group(2)

    return Term(field, norm(strip_quotes(text)), negate)


def parse_query(q):
    terms = []
    for raw in tokenize(q):
        term = parse_token(raw)
        # Sobrou nada depois dos prefixos (ex.: `#`, `""`, `-`): ignora.
        if term.value:
            terms.append(term)
    return terms


def _fields_of(b):
    return {name: norm(b.get(name)) for name in FIELDS}


def _score_term(f, term):
    """None se nao casa, senao pontuacao (maior = melhor)."""
    value = term.value

    if term.field != "any":
        hay = f[term.field]
        i = hay.find(value)
        if i < 0:
            return None
        # Componente inteiro (tag `go` em `go,golang`) vale mais que substring.
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

    # Empate desempata pelo mais recente. Alem disso o sort e estavel nas duas
    # linguagens, entao a ordem de entrada decide o resto — e a paridade se mantem.
    out.sort(key=lambda r: (-r[0], -r[1]))
    return [b for _, _, b in out[:limit]]
