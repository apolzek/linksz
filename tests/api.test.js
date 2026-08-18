'use strict';

// Testes do backend: auth, isolamento entre usuarios, CRUD, busca via API,
// sync bidirecional e os arquivos que fazem a PWA instalar.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, ensureSeedUser } = require('../server/server');
const { verifyPassword } = require('../server/auth');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-test-')), 'vault.db');
const { server } = createApp(tmpDb);
let base;

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const USER = { email: 'apolzek@example.com', username: 'apolzek', password: 'senha123' };
let token;

/* ---------------- auth ---------------- */

test('health responde sem auth', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('registro cria usuario e devolve token (email nao e validado)', async () => {
  const r = await call('POST', '/api/auth/register', { body: USER });
  assert.equal(r.status, 201);
  assert.ok(r.body.token);
  assert.equal(r.body.user.username, 'apolzek');
  assert.equal(r.body.user.pass_hash, undefined, 'hash da senha nao pode vazar');
  token = r.body.token;
});

test('registro duplicado e recusado', async () => {
  assert.equal((await call('POST', '/api/auth/register', { body: USER })).status, 409);
  const mesmoEmail = await call('POST', '/api/auth/register', {
    body: { ...USER, username: 'outro_nome' },
  });
  assert.equal(mesmoEmail.status, 409, 'email repetido tambem barra');
});

test('registro valida entrada', async () => {
  const casos = [
    [{ email: 'x@y.com', username: 'curto', password: '123' }, 'senha curta'],
    [{ email: 'semarroba', username: 'valido', password: 'senha123' }, 'email sem @'],
    [{ email: 'x@y.com', username: 'a', password: 'senha123' }, 'usuario de 1 char'],
    [{ email: 'x@y.com', username: 'com espaco', password: 'senha123' }, 'usuario com espaco'],
    [{ email: 'x@y.com', username: 'Ação', password: 'senha123' }, 'usuario com acento'],
  ];
  for (const [body, motivo] of casos) {
    const r = await call('POST', '/api/auth/register', { body });
    assert.equal(r.status, 400, `deveria recusar: ${motivo}`);
  }
});

test('login por usuario e por email', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { login: 'apolzek', password: 'senha123' } })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { body: { login: USER.email, password: 'senha123' } })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { body: { login: 'APOLZEK', password: 'senha123' } })).status, 200,
    'login nao diferencia caixa');
});

test('login com credencial errada falha', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { login: 'apolzek', password: 'errada' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { login: 'ninguem', password: 'senha123' } })).status, 401);
});

test('rotas protegidas exigem token valido', async () => {
  assert.equal((await call('GET', '/api/bookmarks')).status, 401);
  assert.equal((await call('GET', '/api/bookmarks', { token: 'lixo' })).status, 401);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/sync')).status, 401);
});

/* ---------------- crud ---------------- */

const FIXTURES = [
  { url: 'https://kubernetes.io/docs', title: 'Kubernetes Docs', folder: 'dev/infra', category: '@studies', tags: '#k8s, #devops' },
  { url: 'https://go.dev/blog', title: 'The Go Blog', folder: 'dev', category: 'studies', tags: 'go,backend' },
  { url: 'https://news.ycombinator.com', title: 'Hacker News', folder: 'diario', category: '@news', tags: 'noticias', description: 'leitura diaria' },
  { url: 'https://grafana.com', title: 'Grafana', folder: 'dev/infra', category: 'work', tags: 'observabilidade,devops' },
  { url: 'https://exemplo.com/pagina', title: 'Página com Acentuação', folder: '', category: 'work', tags: 'teste' },
];

test('cria favoritos e normaliza tags/categoria/pasta', async () => {
  for (const f of FIXTURES) {
    const r = await call('POST', '/api/bookmarks', { token, body: f });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const list = await call('GET', '/api/bookmarks', { token });
  assert.equal(list.body.total, FIXTURES.length);

  const k8s = list.body.items.find((b) => b.title === 'Kubernetes Docs');
  assert.equal(k8s.tags, 'k8s,devops', 'tags perdem o # e viram csv');
  assert.equal(k8s.category, 'studies', 'categoria perde o @');
  assert.equal(k8s.folder, 'dev/infra');
});

test('normalizacao remove duplicata e barra sobrando', async () => {
  const r = await call('POST', '/api/bookmarks', {
    token,
    body: { url: 'https://dup.com', title: 'Dup', tags: '#go, go, GO, #Go', folder: '/dev/infra/', category: '@WORK' },
  });
  assert.equal(r.body.item.tags, 'go', 'tag repetida entra uma vez so');
  assert.equal(r.body.item.folder, 'dev/infra', 'barras das pontas somem');
  assert.equal(r.body.item.category, 'work', 'categoria vira minuscula');
  await call('DELETE', `/api/bookmarks/${r.body.item.id}`, { token });
});

test('cria favorito sem url nem titulo e recusado', async () => {
  assert.equal((await call('POST', '/api/bookmarks', { token, body: { tags: 'nada' } })).status, 400);
});

// Cria o proprio favorito e o remove no fim: assim os testes de busca abaixo
// continuam vendo FIXTURES intacto, independente da ordem de execucao.
test('edicao atualiza e mantem created_at', async () => {
  const criado = await call('POST', '/api/bookmarks', {
    token, body: { url: 'https://editar.com', title: 'Para Editar', category: 'antiga', tags: 'antes' },
  });
  const bm = criado.body.item;

  const r = await call('PUT', `/api/bookmarks/${bm.id}`, { token, body: { category: '@monitoring', tags: '#metrics' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.category, 'monitoring');
  assert.equal(r.body.item.tags, 'metrics');
  assert.equal(r.body.item.created_at, bm.created_at);
  assert.ok(r.body.item.updated_at >= bm.updated_at);
  assert.equal(r.body.item.url, bm.url, 'campo nao enviado e preservado');
  assert.equal(r.body.item.title, bm.title, 'titulo nao enviado e preservado');

  await call('DELETE', `/api/bookmarks/${bm.id}`, { token });
});

test('editar id inexistente da 404', async () => {
  assert.equal((await call('PUT', '/api/bookmarks/nao-existe', { token, body: { title: 'x' } })).status, 404);
  assert.equal((await call('GET', '/api/bookmarks/nao-existe', { token })).status, 404);
  assert.equal((await call('DELETE', '/api/bookmarks/nao-existe', { token })).status, 404);
});

/* ---------------- busca via API ---------------- */

async function q(query) {
  const r = await call('GET', `/api/bookmarks?q=${encodeURIComponent(query)}`, { token });
  assert.equal(r.status, 200);
  return r.body.items.map((b) => b.title);
}

test('busca: substring em titulo e url', async () => {
  assert.deepEqual(await q('kuber'), ['Kubernetes Docs']);
  assert.deepEqual(await q('BERNET'), ['Kubernetes Docs'], 'case-insensitive');
  assert.deepEqual(await q('ycombinator'), ['Hacker News']);
  assert.equal((await q('https://')).length, FIXTURES.length, 'casa em todas as urls');
});

test('busca: sigilos de campo', async () => {
  assert.deepEqual((await q('#devops')).sort(), ['Grafana', 'Kubernetes Docs']);
  assert.deepEqual((await q('@studies')).sort(), ['Kubernetes Docs', 'The Go Blog']);
  assert.deepEqual((await q('/dev/infra')).sort(), ['Grafana', 'Kubernetes Docs']);
  assert.equal((await q('/dev')).length, 3, 'pasta pai casa as filhas');
});

test('busca: campo:valor', async () => {
  assert.deepEqual(await q('title:grafana'), ['Grafana']);
  assert.deepEqual(await q('url:ycombinator'), ['Hacker News']);
  assert.deepEqual(await q('description:diaria'), ['Hacker News']);
  assert.deepEqual(await q('title:grafana.com'), [], 'url nao casa em title:');
});

test('busca: frase entre aspas', async () => {
  assert.deepEqual(await q('"hacker news"'), ['Hacker News']);
  assert.deepEqual(await q('"news hacker"'), []);
});

test('busca: negacao', async () => {
  assert.deepEqual(await q('#devops -#k8s'), ['Grafana']);
  assert.deepEqual(await q('/dev -@studies'), ['Grafana']);
  assert.equal((await q('-#devops')).length, FIXTURES.length - 2);
});

test('busca: AND entre termos', async () => {
  assert.deepEqual(await q('#devops @work'), ['Grafana']);
  assert.deepEqual(await q('#devops @news'), []);
});

test('busca: ignora acentos', async () => {
  assert.deepEqual(await q('acentuacao'), ['Página com Acentuação']);
  assert.deepEqual(await q('pagina'), ['Página com Acentuação']);
});

test('busca: sem query lista tudo', async () => {
  assert.equal((await q('')).length, FIXTURES.length);
  assert.equal((await q('   ')).length, FIXTURES.length);
});

test('busca: tag exata ranqueia acima de substring', async () => {
  await call('POST', '/api/bookmarks', { token, body: { url: 'https://golang.org', title: 'Golang', tags: 'golanguage' } });
  assert.equal((await q('#go'))[0], 'The Go Blog', 'tag exata "go" vence a substring "golanguage"');
  const created = await call('GET', '/api/bookmarks?q=golang.org', { token });
  await call('DELETE', `/api/bookmarks/${created.body.items[0].id}`, { token });
});

test('busca: limit e respeitado e limitado', async () => {
  const r = await call('GET', '/api/bookmarks?limit=2', { token });
  assert.equal(r.body.items.length, 2);
  assert.equal(r.body.total, FIXTURES.length, 'total ignora o limit');

  const gigante = await call('GET', '/api/bookmarks?limit=99999', { token });
  assert.ok(gigante.body.items.length <= 500, 'limit tem teto');
});

/* ---------------- exclusao e sync ---------------- */

test('delete some da listagem mas fica no sync como tombstone', async () => {
  const list = await call('GET', '/api/bookmarks?q=Hacker', { token });
  const id = list.body.items[0].id;
  assert.equal((await call('DELETE', `/api/bookmarks/${id}`, { token })).status, 200);
  assert.deepEqual(await q('Hacker'), []);

  const sync = await call('POST', '/api/sync', { token, body: { since: 0 } });
  const tomb = sync.body.changes.find((c) => c.id === id);
  assert.equal(tomb.deleted, 1, 'tombstone propaga a exclusao pros outros clientes');
  assert.equal((await call('DELETE', `/api/bookmarks/${id}`, { token })).status, 404);
});

test('isolamento entre usuarios', async () => {
  const other = await call('POST', '/api/auth/register', {
    body: { email: 'outro@example.com', username: 'outro', password: 'senha123' },
  });
  const list = await call('GET', '/api/bookmarks', { token: other.body.token });
  assert.equal(list.body.total, 0, 'usuario novo nao ve favoritos alheios');

  const mine = await call('GET', '/api/bookmarks?q=Grafana', { token });
  const id = mine.body.items[0].id;
  assert.equal((await call('GET', `/api/bookmarks/${id}`, { token: other.body.token })).status, 404,
    'nao da pra ler favorito de outro usuario por id');
  assert.equal((await call('PUT', `/api/bookmarks/${id}`, { token: other.body.token, body: { title: 'hack' } })).status, 404,
    'nem editar');
  assert.equal((await call('DELETE', `/api/bookmarks/${id}`, { token: other.body.token })).status, 404,
    'nem apagar');

  const ainda = await call('GET', `/api/bookmarks/${id}`, { token });
  assert.equal(ainda.body.item.title, 'Grafana', 'o dono continua com o favorito intacto');
});

test('sync bidirecional entre dois clientes (web <-> desktop)', async () => {
  const a = await call('POST', '/api/sync', {
    token,
    body: { since: 0, changes: [{ id: 'uuid-desktop-1', url: 'https://zed.dev', title: 'Zed', tags: 'editor', category: 'dev', updated_at: Date.now() }] },
  });
  assert.equal(a.body.pushed, 1);

  const b = await call('POST', '/api/sync', { token, body: { since: 0, changes: [] } });
  assert.ok(b.body.changes.some((c) => c.id === 'uuid-desktop-1'));

  const c = await call('POST', '/api/sync', { token, body: { since: b.body.now, changes: [] } });
  assert.equal(c.body.changes.length, 0, 'sync incremental nao reenvia o que ja foi visto');
});

test('sync resolve conflito por last-write-wins', async () => {
  const t0 = Date.now();
  const push = (title, ts) => call('POST', '/api/sync', {
    token, body: { changes: [{ id: 'conflito', url: 'https://a.com', title, updated_at: ts }] },
  });

  await push('antigo', t0);
  await push('novo', t0 + 1000);
  await push('atrasado', t0 - 1000);

  const r = await call('GET', '/api/bookmarks/conflito', { token });
  assert.equal(r.body.item.title, 'novo', 'a escrita mais nova vence');
});

test('sync ignora payload malformado sem derrubar', async () => {
  const r = await call('POST', '/api/sync', { token, body: { since: 'abc', changes: 'nao-e-array' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.pushed, 0);
});

test('logout invalida so a sessao usada', async () => {
  const s = await call('POST', '/api/auth/login', { body: { login: 'apolzek', password: 'senha123' } });
  assert.equal((await call('POST', '/api/auth/logout', { token: s.body.token })).status, 200);
  assert.equal((await call('GET', '/api/bookmarks', { token: s.body.token })).status, 401);
  assert.equal((await call('GET', '/api/bookmarks', { token })).status, 200, 'outras sessoes continuam validas');
});

/* ---------------- export e import ---------------- */

async function baixar(format) {
  const res = await fetch(`${base}/api/export?format=${format}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, headers: res.headers, texto: await res.text() };
}

test('export exige autenticacao', async () => {
  assert.equal((await fetch(`${base}/api/export`)).status, 401);
});

test('export yaml vem como download com nome de arquivo', async () => {
  const r = await baixar('yaml');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /yaml/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="vaultmarks-\d{4}-\d{2}-\d{2}\.yaml"/);
  assert.match(r.texto, /^# Vaultmarks/);
  assert.match(r.texto, /^bookmarks:$/m);
});

test('export html e o formato que o navegador importa', async () => {
  const r = await baixar('html');
  assert.match(r.texto, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(r.headers.get('content-disposition'), /\.html"/);
});

test('export json', async () => {
  const r = await baixar('json');
  const doc = JSON.parse(r.texto);
  assert.ok(Array.isArray(doc.bookmarks));
});

test('export com formato invalido e recusado', async () => {
  const r = await call('GET', '/api/export?format=xml', { token });
  assert.equal(r.status, 400);
});

test('import sem apply nao grava nada', async () => {
  const antes = (await call('GET', '/api/bookmarks', { token })).body.total;
  const conteudo = 'bookmarks:\n  - title: Fantasma\n    url: https://fantasma.com\n';

  const r = await call('POST', '/api/import', { token, body: { content: conteudo, mode: 'adicionar' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.aplicado, false);
  assert.equal(r.body.resumo.criar, 1);
  assert.equal(r.body.formato, 'yaml');

  const depois = (await call('GET', '/api/bookmarks', { token })).body.total;
  assert.equal(depois, antes, 'preview nao pode alterar o vault');
  assert.deepEqual(await q('Fantasma'), [], 'nada foi criado');
});

test('import aplica e depois e idempotente', async () => {
  const conteudo = 'bookmarks:\n  - title: Importado\n    url: https://importado.com\n    tags: [novo]\n';

  const um = await call('POST', '/api/import', { token, body: { content: conteudo, mode: 'adicionar', apply: true } });
  assert.equal(um.body.aplicado, true);
  assert.equal(um.body.resumo.criar, 1);
  assert.deepEqual(await q('Importado'), ['Importado']);

  const dois = await call('POST', '/api/import', { token, body: { content: conteudo, mode: 'adicionar', apply: true } });
  assert.equal(dois.body.resumo.criar, 0, 'reimportar nao duplica');
  assert.equal(dois.body.resumo.iguais, 1);
  assert.deepEqual(await q('Importado'), ['Importado']);
});

test('import respeita o modo escolhido', async () => {
  const editado = 'bookmarks:\n  - title: Importado EDITADO\n    url: https://importado.com\n    tags: [novo]\n';

  const mantendo = await call('POST', '/api/import', { token, body: { content: editado, mode: 'adicionar', apply: true } });
  assert.equal(mantendo.body.resumo.ignorar, 1);
  assert.deepEqual(await q('Importado'), ['Importado'], 'modo adicionar preserva o titulo antigo');

  const usandoArquivo = await call('POST', '/api/import', { token, body: { content: editado, mode: 'atualizar', apply: true } });
  assert.equal(usandoArquivo.body.resumo.atualizar, 1);
  assert.deepEqual(await q('Importado'), ['Importado EDITADO']);
});

test('import do proprio export nao muda nada', async () => {
  const { texto } = await baixar('yaml');
  const r = await call('POST', '/api/import', { token, body: { content: texto, mode: 'atualizar', apply: true } });
  assert.equal(r.body.resumo.criar, 0);
  assert.equal(r.body.resumo.atualizar, 0);
  assert.ok(r.body.resumo.iguais > 0, 'tudo bate consigo mesmo');
});

test('import le o formato do navegador', async () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3>navegador</H3>
    <DL><p>
        <DT><A HREF="https://veio-do-chrome.com" ADD_DATE="1700000000">Do Chrome</A>
    </DL><p>
</DL><p>`;
  const r = await call('POST', '/api/import', { token, body: { content: html, apply: true } });
  assert.equal(r.body.formato, 'html');
  assert.equal(r.body.resumo.criar, 1);
  assert.deepEqual(await q('/navegador'), ['Do Chrome'], 'a pasta do navegador virou pasta do vault');
});

test('import da erro util em arquivo quebrado', async () => {
  const quebrado = await call('POST', '/api/import', { token, body: { content: 'bookmarks:\n\t- x\n' } });
  assert.equal(quebrado.status, 400);
  assert.match(quebrado.body.error, /nao consegui ler/);
  assert.match(quebrado.body.error, /linha 2/, 'o erro precisa dizer onde');

  const vazio = await call('POST', '/api/import', { token, body: { content: '   ' } });
  assert.equal(vazio.status, 400);

  const modoErrado = await call('POST', '/api/import', { token, body: { content: 'bookmarks: []', mode: 'apagar' } });
  assert.equal(modoErrado.status, 400);
  assert.match(modoErrado.body.error, /modo deve ser/);
});

test('import nao vaza entre usuarios', async () => {
  const outro = await call('POST', '/api/auth/register', {
    body: { email: 'imp@example.com', username: 'importador', password: 'senha123' },
  });
  const r = await call('POST', '/api/import', {
    token: outro.body.token,
    body: { content: 'bookmarks:\n  - title: So dele\n    url: https://dele.com\n', apply: true },
  });
  assert.equal(r.body.resumo.criar, 1);

  const meu = await call('GET', '/api/bookmarks?q=dele.com', { token });
  assert.equal(meu.body.items.length, 0, 'o import de um usuario nao aparece no outro');
});

test('substituir remove o que nao veio no arquivo — e avisa antes', async () => {
  const solo = await call('POST', '/api/auth/register', {
    body: { email: 'sub@example.com', username: 'substituidor', password: 'senha123' },
  });
  const t = solo.body.token;
  for (const url of ['https://a.com', 'https://b.com']) {
    await call('POST', '/api/bookmarks', { token: t, body: { url, title: url } });
  }

  const conteudo = 'bookmarks:\n  - title: Só este\n    url: https://a.com\n';
  const preview = await call('POST', '/api/import', { token: t, body: { content: conteudo, mode: 'substituir' } });
  assert.equal(preview.body.resumo.remover, 1);
  assert.deepEqual(preview.body.exemplos.remover, ['https://b.com']);
  assert.equal((await call('GET', '/api/bookmarks', { token: t })).body.total, 2, 'ainda nao removeu');

  await call('POST', '/api/import', { token: t, body: { content: conteudo, mode: 'substituir', apply: true } });
  const restante = await call('GET', '/api/bookmarks', { token: t });
  assert.equal(restante.body.total, 1);
  assert.equal(restante.body.items[0].url, 'https://a.com');
});

/* ---------------- web e PWA ---------------- */

test('web e servida na raiz', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /vaultmarks/i);
});

test('nao serve arquivo fora de web/', async () => {
  for (const p of ['/../server/db.js', '/../../etc/passwd', '/%2e%2e/server/db.js']) {
    const res = await fetch(base + p);
    assert.ok(res.status === 403 || res.status === 404, `${p} devolveu ${res.status}`);
  }
});

test('assets da PWA existem e sao servidos', async () => {
  const esperados = [
    '/manifest.webmanifest', '/sw.js', '/icon.svg',
    '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
    '/style.css', '/app.js', '/search.js',
  ];
  for (const p of esperados) {
    assert.equal((await fetch(base + p)).status, 200, `${p} deveria existir`);
  }
});

test('manifest tem o content-type que o navegador exige', async () => {
  const res = await fetch(base + '/manifest.webmanifest');
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/,
    'sem este tipo o navegador ignora o manifest e nao oferece instalar');
});

test('manifest declara o minimo para ser instalavel', async () => {
  const m = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.ok(m.name && m.short_name, 'precisa de nome');
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone', 'senao abre como aba comum');
  assert.ok(m.theme_color && m.background_color);

  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), 'Android exige um icone 192');
  assert.ok(sizes.includes('512x512'), 'Android exige um icone 512');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'sem maskable o Android recorta torto');
});

test('service worker vem com cabecalhos que permitem atualizar', async () => {
  const res = await fetch(base + '/sw.js');
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-cache',
    'sw cacheado prende o app numa versao velha');
  assert.equal(res.headers.get('service-worker-allowed'), '/');
});

test('service worker nao intercepta a API', async () => {
  const sw = await (await fetch(base + '/sw.js')).text();
  assert.match(sw, /\/api\//, 'precisa tratar /api/ explicitamente');
  assert.match(sw, /request\.method !== 'GET'/, 'escrita nunca pode sair do cache');
});

test('icones sao PNG de verdade', async () => {
  for (const p of ['/icon-192.png', '/icon-512.png']) {
    const res = await fetch(base + p);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${p} nao e PNG`);
  }
});

test('index aponta para manifest, icone e viewport de celular', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /rel="manifest"/, 'sem link do manifest nao instala');
  assert.match(html, /apple-touch-icon/, 'iOS usa este icone na tela de inicio');
  assert.match(html, /viewport-fit=cover/, 'sem isso o conteudo some atras do notch');
  assert.match(html, /theme-color/);
});

/* ---------------- conta de teste ---------------- */

// Mesmo caminho do boot real (server.js chama isto antes do listen), so que
// com banco descartavel e o ambiente restaurado no fim.
function bootSeed(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-seed-'));
  const dbPath = path.join(dir, 'vault.db');
  const antes = {};
  for (const [k, v] of Object.entries(env)) { antes[k] = process.env[k]; process.env[k] = v; }

  const users = (app) => app.db.prepare('SELECT * FROM users').all();
  try {
    const primeiro = createApp(dbPath);
    ensureSeedUser(primeiro.db);
    const depoisDoPrimeiroBoot = users(primeiro);
    primeiro.db.close();

    // Segundo boot no mesmo banco: e onde a idempotencia aparece.
    const segundo = createApp(dbPath);
    ensureSeedUser(segundo.db);
    const depoisDoSegundoBoot = users(segundo);
    segundo.db.close();

    return { depoisDoPrimeiroBoot, depoisDoSegundoBoot };
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('boot cria a conta de teste com a senha padrao', () => {
  const { depoisDoPrimeiroBoot } = bootSeed();
  assert.equal(depoisDoPrimeiroBoot.length, 1);
  assert.equal(depoisDoPrimeiroBoot[0].username, 'teste');
  assert.equal(depoisDoPrimeiroBoot[0].email, 'teste@vaultmarks.local');
  assert.ok(verifyPassword('teste123', depoisDoPrimeiroBoot[0].pass_hash));
});

test('segundo boot nao duplica a conta nem invalida a senha', () => {
  const { depoisDoSegundoBoot } = bootSeed();
  assert.equal(depoisDoSegundoBoot.length, 1);
  assert.ok(verifyPassword('teste123', depoisDoSegundoBoot[0].pass_hash));
});

test('VAULTMARKS_SEED=0 nao cria conta nenhuma', () => {
  const { depoisDoSegundoBoot } = bootSeed({ VAULTMARKS_SEED: '0' });
  assert.equal(depoisDoSegundoBoot.length, 0);
});

test('usuario e senha da conta de teste vem do ambiente', () => {
  const { depoisDoPrimeiroBoot } = bootSeed({
    VAULTMARKS_SEED_USER: 'qa',
    VAULTMARKS_SEED_PASSWORD: 'segredo123',
  });
  assert.equal(depoisDoPrimeiroBoot[0].username, 'qa');
  assert.equal(depoisDoPrimeiroBoot[0].email, 'qa@vaultmarks.local');
  assert.ok(verifyPassword('segredo123', depoisDoPrimeiroBoot[0].pass_hash));
  assert.ok(!verifyPassword('teste123', depoisDoPrimeiroBoot[0].pass_hash));
});

test('senha trocada no ambiente e reacertada no boot seguinte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-seed-'));
  const dbPath = path.join(dir, 'vault.db');
  try {
    const a = createApp(dbPath);
    ensureSeedUser(a.db);
    a.db.close();

    process.env.VAULTMARKS_SEED_PASSWORD = 'nova-senha';
    const b = createApp(dbPath);
    ensureSeedUser(b.db);
    const [u] = b.db.prepare('SELECT * FROM users').all();
    b.db.close();

    assert.ok(verifyPassword('nova-senha', u.pass_hash));
  } finally {
    delete process.env.VAULTMARKS_SEED_PASSWORD;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
