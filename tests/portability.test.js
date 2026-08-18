'use strict';

// Testes de import/export: formatos, casamento por URL e — o que mais importa —
// o plano de import, que decide o que fazer quando o favorito já existe.

const test = require('node:test');
const assert = require('node:assert');

const p = require('../server/portability');
const yaml = require('../server/yaml');

const VAULT = [
  { id: 'v1', title: 'Kubernetes Docs', url: 'https://kubernetes.io/docs', folder: 'dev/infra',
    category: 'studies', tags: 'k8s,devops', description: '', created_at: 100, updated_at: 500 },
  { id: 'v2', title: 'The Go Blog', url: 'https://go.dev/blog', folder: 'dev',
    category: 'studies', tags: 'go', description: 'ler', created_at: 100, updated_at: 400 },
];

/* ---------------- identidade por URL ---------------- */

test('urlKey ignora diferencas que nao mudam a pagina', () => {
  const mesma = [
    ['https://go.dev/blog', 'https://go.dev/blog/'],
    ['https://go.dev/blog', 'http://go.dev/blog'],
    ['https://go.dev/blog', 'https://www.go.dev/blog'],
    ['https://go.dev/blog', 'HTTPS://GO.DEV/blog'],
    ['https://go.dev/blog', 'https://go.dev/blog#secao'],
  ];
  for (const [a, b] of mesma) {
    assert.equal(p.urlKey(a), p.urlKey(b), `${a} deveria casar com ${b}`);
  }
});

test('urlKey separa o que e pagina diferente', () => {
  const diferente = [
    ['https://go.dev/blog', 'https://go.dev/docs'],
    ['https://go.dev/?p=1', 'https://go.dev/?p=2'],
    ['https://go.dev', 'https://outro.dev'],
  ];
  for (const [a, b] of diferente) {
    assert.notEqual(p.urlKey(a), p.urlKey(b), `${a} nao deveria casar com ${b}`);
  }
});

test('urlKey aguenta lixo sem explodir', () => {
  assert.equal(p.urlKey(''), '');
  assert.equal(p.urlKey(null), '');
  assert.equal(p.urlKey('nao é url'), 'nao é url');
});

/* ---------------- exportar ---------------- */

test('export yaml relê como o mesmo vault', () => {
  const doc = yaml.parse(p.toYaml(VAULT, { user: 'apolzek' }));
  assert.equal(doc.version, 1);
  assert.equal(doc.count, 2);
  assert.deepEqual(doc.bookmarks.map((b) => b.title), ['Kubernetes Docs', 'The Go Blog']);
  assert.deepEqual(doc.bookmarks[0].tags, ['k8s', 'devops'], 'tags viram lista no arquivo');
});

test('export yaml volta pelo import sem perder campo', () => {
  const { items } = p.parseImport(p.toYaml(VAULT));
  assert.equal(items.length, 2);
  const k8s = items[0];
  assert.equal(k8s.id, 'v1');
  assert.equal(k8s.folder, 'dev/infra');
  assert.equal(k8s.category, 'studies');
  assert.equal(k8s.tags, 'k8s,devops', 'a lista do arquivo volta a ser csv');
  assert.equal(k8s.created_at, 100);
});

test('export html e reconhecido como formato de navegador', () => {
  const html = p.toNetscapeHtml(VAULT);
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /<DT><H3>dev<\/H3>/, 'pasta vira <H3>');
  assert.match(html, /HREF="https:\/\/kubernetes\.io\/docs"/);
  assert.match(html, /TAGS="k8s,devops"/);
  assert.equal(p.detectFormat(html), 'html');
});

test('export html escapa o que quebraria o arquivo', () => {
  const html = p.toNetscapeHtml([
    { id: 'x', title: 'A & B <script>', url: 'https://x.com/?a=1&b="2"', tags: '', folder: '' },
  ]);
  assert.ok(!html.includes('<script>'), 'tag nao pode passar crua');
  assert.match(html, /A &amp; B &lt;script&gt;/);
  const { items } = p.parseImport(html);
  assert.equal(items[0].title, 'A & B <script>', 'e volta ao original na leitura');
});

test('export json', () => {
  const doc = JSON.parse(p.toJson(VAULT));
  assert.equal(doc.count, 2);
  assert.equal(doc.bookmarks[0].id, 'v1');
  assert.equal(p.detectFormat(p.toJson(VAULT)), 'json');
});

/* ---------------- ler o formato do navegador ---------------- */

const CHROME = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><A HREF="https://raiz.com" ADD_DATE="1700000000">Na raiz</A>
    <DT><H3>dev</H3>
    <DL><p>
        <DT><A HREF="https://go.dev" ADD_DATE="1700000001" LAST_MODIFIED="1700000002">Go</A>
        <DD>uma nota
        <DT><H3>infra</H3>
        <DL><p>
            <DT><A HREF="https://k8s.io" TAGS="k8s,devops">Kubernetes</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="javascript:void(0)">Bookmarklet</A>
    <DT><A HREF="https://acento.com">Página com Acentuação &amp; cia</A>
</DL><p>`;

test('le a arvore de pastas do navegador', () => {
  const { format, items } = p.parseImport(CHROME);
  assert.equal(format, 'html');
  const porTitulo = Object.fromEntries(items.map((b) => [b.title, b]));

  assert.equal(items.length, 4, 'bookmarklet nao conta como favorito');
  assert.equal(porTitulo['Na raiz'].folder, '');
  assert.equal(porTitulo.Go.folder, 'dev');
  assert.equal(porTitulo.Kubernetes.folder, 'dev/infra', 'pasta aninhada vira caminho');
});

test('le datas, tags, notas e entidades HTML', () => {
  const { items } = p.parseImport(CHROME);
  const porTitulo = Object.fromEntries(items.map((b) => [b.title, b]));

  assert.equal(porTitulo.Go.created_at, 1700000001000, 'ADD_DATE e em segundos');
  assert.equal(porTitulo.Go.updated_at, 1700000002000);
  assert.equal(porTitulo.Go.description, 'uma nota', '<DD> vira nota');
  assert.equal(porTitulo.Kubernetes.tags, 'k8s,devops');
  assert.equal(porTitulo['Página com Acentuação & cia'].url, 'https://acento.com');
});

test('detecta o formato sozinho', () => {
  assert.equal(p.detectFormat(CHROME), 'html');
  assert.equal(p.detectFormat('version: 1\nbookmarks: []\n'), 'yaml');
  assert.equal(p.detectFormat('{"bookmarks": []}'), 'json');
  assert.equal(p.detectFormat('[{"url": "x"}]'), 'json');
});

test('arquivo ilegivel da erro em vez de importar vazio', () => {
  assert.throws(() => p.parseImport('a: 1\nb: 2\n'), /bookmarks/,
    'YAML valido mas sem a lista nao pode passar batido');
  assert.throws(() => p.parseImport('{"nada": 1}', 'json'), /bookmarks/);
});

test('normaliza o que vem de fora', () => {
  const { items } = p.parseImport(yaml.stringify({
    bookmarks: [{ title: '  Espacos  ', url: ' https://x.com ', tags: ['#Go', 'GO', 'cli'],
      category: '@Work', folder: '/dev/infra/' }],
  }));
  const b = items[0];
  assert.equal(b.title, 'Espacos');
  assert.equal(b.url, 'https://x.com');
  assert.equal(b.tags, 'go,cli', 'tag repetida entra uma vez, sem # e minuscula');
  assert.equal(b.category, 'work');
  assert.equal(b.folder, 'dev/infra');
});

/* ---------------- o plano de import ---------------- */

const novo = (extra = {}) => p.normalizeIncoming({ title: 'Novo', url: 'https://novo.com', ...extra });
const igualAoVault = () => p.normalizeIncoming({ ...VAULT[0] });
const editado = (extra = {}) => p.normalizeIncoming({ ...VAULT[0], title: 'Kubernetes EDITADO', ...extra });

test('entrada nova entra em qualquer modo', () => {
  for (const modo of p.MODES) {
    const plano = p.planImport(VAULT, [novo()], modo);
    assert.equal(plano.resumo.criar, 1, `modo ${modo}`);
  }
});

test('entrada identica nao mexe em nada', () => {
  for (const modo of p.MODES) {
    const plano = p.planImport(VAULT, [igualAoVault()], modo);
    assert.equal(plano.resumo.iguais, 1, `modo ${modo}`);
    assert.equal(plano.resumo.atualizar, 0, `modo ${modo} nao pode reescrever o que nao mudou`);
  }
});

test('modo adicionar preserva o que ja estava', () => {
  const plano = p.planImport(VAULT, [editado()], 'adicionar');
  assert.equal(plano.resumo.atualizar, 0);
  assert.equal(plano.resumo.ignorar, 1);
  assert.match(plano.ignorar[0].motivo, /ja existe/);
});

test('modo atualizar sobrescreve com o arquivo', () => {
  const plano = p.planImport(VAULT, [editado()], 'atualizar');
  assert.equal(plano.resumo.atualizar, 1);
  assert.equal(plano.atualizar[0].incoming.title, 'Kubernetes EDITADO');
  assert.equal(plano.atualizar[0].incoming.id, 'v1', 'mantem o id do vault');
  assert.equal(plano.atualizar[0].incoming.created_at, 100, 'created_at do vault e preservado');
});

test('modo mais-recente compara updated_at', () => {
  const maisNovo = p.planImport(VAULT, [editado({ updated_at: 999 })], 'mais-recente');
  assert.equal(maisNovo.resumo.atualizar, 1, 'arquivo mais novo vence');

  const maisVelho = p.planImport(VAULT, [editado({ updated_at: 1 })], 'mais-recente');
  assert.equal(maisVelho.resumo.atualizar, 0, 'arquivo mais velho perde');
  assert.match(maisVelho.ignorar[0].motivo, /mais nova/);
});

test('modo substituir remove o que nao esta no arquivo', () => {
  const plano = p.planImport(VAULT, [igualAoVault()], 'substituir');
  assert.equal(plano.resumo.remover, 1);
  assert.equal(plano.remover[0].atual.id, 'v2', 'so o que nao veio no arquivo sai');
});

test('substituir com arquivo vazio esvazia — e o plano diz isso antes', () => {
  const plano = p.planImport(VAULT, [], 'substituir');
  assert.equal(plano.resumo.remover, 2);
  assert.equal(plano.resumo.criar, 0);
});

test('casamento por URL, mesmo sem id e com titulo diferente', () => {
  const daWeb = p.normalizeIncoming({ title: 'Outro nome', url: 'https://go.dev/blog/' });
  const plano = p.planImport(VAULT, [daWeb], 'atualizar');
  assert.equal(plano.resumo.criar, 0, 'a barra no fim nao pode criar duplicata');
  assert.equal(plano.resumo.atualizar, 1);
  assert.equal(plano.atualizar[0].atual.id, 'v2');
});

test('id vence a URL quando os dois existem', () => {
  const mudouUrl = p.normalizeIncoming({ id: 'v1', title: 'Kubernetes Docs', url: 'https://novo-endereco.io',
    folder: 'dev/infra', category: 'studies', tags: 'k8s,devops' });
  const plano = p.planImport(VAULT, [mudouUrl], 'atualizar');
  assert.equal(plano.resumo.criar, 0, 'mudar a url de um id conhecido nao cria outro');
  assert.equal(plano.atualizar[0].atual.id, 'v1');
});

test('reimportar o proprio export nao muda nada', () => {
  const { items } = p.parseImport(p.toYaml(VAULT));
  for (const modo of p.MODES) {
    const plano = p.planImport(VAULT, items, modo);
    assert.equal(plano.resumo.iguais, 2, `modo ${modo}`);
    assert.equal(plano.resumo.criar, 0, `modo ${modo}`);
    assert.equal(plano.resumo.atualizar, 0, `modo ${modo}`);
    assert.equal(plano.resumo.remover, 0, `modo ${modo}`);
  }
});

test('reimportar o export html tambem nao duplica', () => {
  const { items } = p.parseImport(p.toNetscapeHtml(VAULT));
  const plano = p.planImport(VAULT, items, 'adicionar');
  assert.equal(plano.resumo.criar, 0, 'o html perde tags/categoria, mas a URL ainda casa');
});

test('duplicata dentro do vault nao rouba o par', () => {
  const comDup = [...VAULT, { id: 'v3', title: 'Copia', url: 'https://go.dev/blog', tags: '', folder: '', category: '', description: '', updated_at: 1 }];
  const plano = p.planImport(comDup, [p.normalizeIncoming({ title: 'X', url: 'https://go.dev/blog' })], 'atualizar');
  assert.equal(plano.atualizar[0].atual.id, 'v2', 'casa com o primeiro, nao com a copia');
});

test('modo invalido e recusado', () => {
  assert.throws(() => p.planImport(VAULT, [], 'apagar-tudo'), /modo invalido/);
});

test('resumo bate com as listas', () => {
  const plano = p.planImport(VAULT, [novo(), editado(), igualAoVault()], 'atualizar');
  assert.equal(plano.resumo.criar, plano.criar.length);
  assert.equal(plano.resumo.atualizar, plano.atualizar.length);
  assert.equal(plano.resumo.iguais, plano.iguais.length);
  assert.equal(plano.resumo.lidos, 3);
});

test('arquivo com o nome antigo do campo (notes) ainda importa', () => {
  const yaml = ['bookmarks:', '  - title: Velho', '    url: https://velho.com', '    notes: veio do formato antigo'].join('\n');
  const { items } = p.parseImport(yaml, 'yaml');
  assert.equal(items[0].description, 'veio do formato antigo');
});
