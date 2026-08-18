/* Vaultmarks — web. Estrategia: carrega tudo em memoria e busca localmente
   (instantaneo, sem round-trip). Escritas vao pro servidor e o sync roda em
   background pra convergir com a app desktop. */
'use strict';

const $ = (s) => document.querySelector(s);
const API = '';

const state = {
  token: localStorage.getItem('vm_token') || '',
  items: [],          // todos os bookmarks vivos
  results: [],
  sel: 0,
  editing: null,
  lastSync: 0,
  filtroPainel: {},   // filtros das listas do painel (nao filtram favoritos)
  pastasFechadas: new Set(JSON.parse(localStorage.getItem('vm_pastas_fechadas') || '[]')),
};

/* ---------------- http ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...opts.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `error ${res.status}`);
  return body;
}

function setSync(text, cls = '') {
  const el = $('#sync-state');
  el.textContent = text;
  el.className = 'sync ' + cls;
}

/* ---------------- auth ---------------- */
let authMode = 'login';

// `fetch` rejeita com TypeError("Failed to fetch") para qualquer falha de rede
// — servidor parado, porta errada, DNS. A mensagem crua nao diz nada, entao
// aqui a falha e classificada antes de virar texto.
function ehErroDeRede(err) {
  return err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(err.message || '');
}

// Nao pergunta "o backend esta rodando?" — checa e afirma. Erro de servidor
// (senha errada, usuario duplicado) vai para a linha embaixo do botao; queda
// de rede vira o semaforo e o bloco com o que fazer, sem repetir o texto nos
// tres lugares.
async function relatarFalha(err) {
  if (!ehErroDeRede(err)) {
    $('#auth-error').textContent = err.message;
    return;
  }
  const vivo = await checarServidor();
  $('#auth-error').textContent = vivo ? 'the connection dropped mid-request — try again' : '';
}

function renderAuthMode() {
  const isReg = authMode === 'register';
  $('#w-login').classList.toggle('hidden', isReg);
  $('#f-login').required = !isReg;
  $('#w-email').classList.toggle('hidden', !isReg);
  $('#f-email').required = isReg;
  $('#w-username').classList.toggle('hidden', !isReg);
  $('#f-username').required = isReg;
  $('#pw-hint').classList.toggle('hidden', !isReg);
  $('#auth-submit').textContent = isReg ? 'Create account' : 'Sign in';
  $('#f-password').autocomplete = isReg ? 'new-password' : 'current-password';
  $('#f-password').minLength = isReg ? 6 : 0;
  $('#auth-error').textContent = '';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === authMode));
  (isReg ? $('#f-email') : $('#f-login')).focus();
}

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => { authMode = t.dataset.mode; renderAuthMode(); };
});

$('#pw-toggle').onclick = () => {
  const campo = $('#f-password');
  const mostrando = campo.type === 'text';
  campo.type = mostrando ? 'password' : 'text';
  $('#pw-toggle').classList.toggle('on', !mostrando);
  $('#pw-toggle').title = mostrando ? 'Mostrar senha' : 'Ocultar senha';
  campo.focus();
};

async function entrar(credenciais, modo = authMode) {
  const botao = $('#auth-submit');
  const rotulo = botao.textContent;
  botao.disabled = true;
  botao.textContent = modo === 'register' ? 'creating…' : 'signing in…';
  $('#auth-error').textContent = '';
  try {
    const r = await api(`/api/auth/${modo}`, { method: 'POST', body: JSON.stringify(credenciais) });
    state.token = r.token;
    localStorage.setItem('vm_token', r.token);
    $('#auth-offline').classList.add('hidden');
    await enterApp();
  } catch (err) {
    await relatarFalha(err);
  } finally {
    botao.disabled = false;
    botao.textContent = rotulo;
  }
}

$('#auth-form').onsubmit = (e) => {
  e.preventDefault();
  const password = $('#f-password').value;
  return entrar(authMode === 'register'
    ? { email: $('#f-email').value.trim(), username: $('#f-username').value.trim(), password }
    : { login: $('#f-login').value.trim(), password });
};

// Diz de cara se o backend responde, em vez de esperar a pessoa errar a senha
// para descobrir que o problema era outro.
function pintarStatus(estado, texto) {
  const el = $('#auth-status');
  el.className = `status ${estado}`;
  $('#auth-status-text').textContent = texto;
}

async function checarServidor() {
  $('#auth-origin').textContent = location.origin;
  pintarStatus('checking', 'checking the backend…');
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const body = await r.json();
    $('#auth-offline').classList.add('hidden');
    pintarStatus('up', `backend up at ${location.origin}`);

    const demo = $('#auth-demo');
    if (body.demo?.login) {
      demo.textContent = `sign in to the test account (${body.demo.login})`;
      demo.classList.remove('hidden');
    } else {
      demo.classList.add('hidden');
    }
    return true;
  } catch {
    $('#auth-offline').classList.remove('hidden');
    $('#auth-demo').classList.add('hidden');
    pintarStatus('down', `backend down at ${location.origin}`);
    return false;
  }
}

$('#auth-retry').onclick = async () => {
  const btn = $('#auth-retry');
  btn.disabled = true;
  btn.textContent = 'checking…';
  $('#auth-error').textContent = '';
  const ok = await checarServidor();
  btn.disabled = false;
  btn.textContent = 'check again';
  // Sessao ainda valida + servidor de volta: nao ha o que perguntar.
  if (ok && state.token) {
    try { await api('/api/me'); await enterApp(); } catch {}
  }
};

$('#auth-demo').onclick = () => entrar({ login: 'teste', password: 'teste123' }, 'login');

$('#btn-logout').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  localStorage.removeItem('vm_token');
  state.token = '';
  state.items = [];
  location.reload();
};

/* ---------------- dados ---------------- */
async function loadAll() {
  const r = await api('/api/bookmarks?limit=500');
  state.items = r.items;
  state.lastSync = Date.now();
  refreshDatalists();
  render();
}

// Puxa so o que mudou desde o ultimo sync (inclui mudancas feitas no desktop).
async function pullChanges() {
  try {
    const r = await api('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ since: state.lastSync, changes: [] }),
    });
    state.lastSync = r.now;
    if (!r.changes.length) return;
    for (const c of r.changes) {
      const i = state.items.findIndex((b) => b.id === c.id);
      if (c.deleted) { if (i >= 0) state.items.splice(i, 1); continue; }
      if (i >= 0) state.items[i] = c; else state.items.unshift(c);
    }
    refreshDatalists();
    render();
    setSync('synced');
  } catch {
    setSync('offline', 'err');
  }
}

function refreshDatalists() {
  const fill = (el, values) => {
    el.innerHTML = '';
    for (const v of [...new Set(values)].filter(Boolean).sort()) {
      const o = document.createElement('option');
      o.value = v;
      el.appendChild(o);
    }
  };
  fill($('#dl-folders'), state.items.map((b) => b.folder));
  fill($('#dl-categories'), state.items.map((b) => b.category));
}

/* ---------------- render ---------------- */
function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  const plain = VMSearch.norm(text);
  const spans = [];
  for (const t of terms) {
    if (!t.value) continue;
    let from = 0, i;
    while ((i = plain.indexOf(t.value, from)) >= 0) {
      spans.push([i, i + t.value.length]);
      from = i + t.value.length;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [s, e] of spans) {
    if (s < cursor) continue;
    frag.append(text.slice(cursor, s));
    const m = document.createElement('mark');
    m.textContent = text.slice(s, e);
    frag.append(m);
    cursor = e;
  }
  frag.append(text.slice(cursor));
  return frag;
}

function faviconFor(url) {
  try { return `https://icons.duckduckgo.com/ip3/${new URL(url).hostname}.ico`; } catch { return ''; }
}

function iconButton(glyph, title, onClick) {
  const el = document.createElement('button');
  el.className = 'icon-btn';
  el.type = 'button';
  el.textContent = glyph;
  el.title = title;
  el.setAttribute('aria-label', title);
  el.onclick = (e) => { e.stopPropagation(); onClick(); };
  return el;
}

// Liga/desliga um filtro (#tag, @categoria, /pasta) mantendo os outros —
// e o que permite cruzar "@work #k8s" so clicando.
function toggleToken(token) {
  const atual = $('#q').value.trim();
  const partes = atual.split(/\s+/).filter(Boolean);
  const i = partes.findIndex((p) => p.toLowerCase() === token.toLowerCase());
  if (i >= 0) partes.splice(i, 1); else partes.push(token);
  setQuery(partes.join(' '));
}

function tokenAtivo(token) {
  return $('#q').value.trim().split(/\s+/).some((p) => p.toLowerCase() === token.toLowerCase());
}

function badge(cls, text, onClick) {
  const el = document.createElement('span');
  el.className = `badge ${cls}`;
  el.textContent = text;
  el.onclick = (e) => { e.stopPropagation(); onClick(); };
  return el;
}

function render() {
  const q = $('#q').value;
  const terms = VMSearch.parseQuery(q);
  // Sem corte: o painel existe para varrer o vault inteiro, e cortar em 50
  // esconderia justamente a cauda que a pessoa esta procurando.
  state.results = VMSearch.search(state.items, q, state.items.length || 1);
  if (state.sel >= state.results.length) state.sel = Math.max(0, state.results.length - 1);

  $('#q-clear').classList.toggle('hidden', !q);

  const ul = $('#results');
  ul.innerHTML = '';
  for (const [i, b] of state.results.entries()) {
    const li = document.createElement('li');
    li.className = 'item' + (i === state.sel ? ' sel' : '');
    li.onclick = (e) => { state.sel = i; openSelected(e.ctrlKey || e.metaKey); };
    li.oncontextmenu = (e) => { e.preventDefault(); openModal(b); };

    if (b.url) {
      const img = document.createElement('img');
      img.className = 'favicon';
      img.src = faviconFor(b.url);
      img.onerror = () => { img.style.visibility = 'hidden'; };
      li.append(img);
    }

    const main = document.createElement('div');
    main.className = 'item-main';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.append(highlight(b.title || b.url, terms));
    const url = document.createElement('div');
    url.className = 'item-url';
    url.append(highlight(b.url, terms));
    main.append(title, url);
    li.append(main);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    if (b.folder) meta.append(badge('folder', '/' + b.folder, () => toggleToken('/' + b.folder)));
    if (b.category) meta.append(badge('cat', '@' + b.category, () => toggleToken('@' + b.category)));
    for (const t of b.tags.split(',').filter(Boolean).slice(0, 3)) {
      meta.append(badge('tag', '#' + t, () => toggleToken('#' + t)));
    }
    li.append(meta);

    // Editar so por clique-direito e tecla `e` nao se descobre, e no celular
    // nem existe: por isso os botoes ficam na linha.
    const acoes = document.createElement('div');
    acoes.className = 'item-actions';
    acoes.append(
      iconButton('✎', 'Edit', () => openModal(b)),
      iconButton('🗑', 'Delete', () => removeBookmark(b)),
    );
    li.append(acoes);
    ul.append(li);
  }

  const total = state.items.length;
  const count = $('#count');
  if (!total) {
    count.textContent = '';
  } else if (state.results.length === total) {
    count.textContent = `${total} bookmark${total > 1 ? 's' : ''}`;
  } else {
    count.textContent = `${state.results.length} of ${total} bookmarks`;
  }

  const empty = $('#empty');
  if (!state.results.length) {
    empty.classList.remove('hidden');
    empty.textContent = state.items.length
      ? `no bookmark matches "${q}"`
      : 'no bookmarks yet — click "+ new" or press n';
  } else {
    empty.classList.add('hidden');
  }

  renderChips();
  renderBrowse();
  document.querySelector('.item.sel')?.scrollIntoView({ block: 'nearest' });
}

// O painel lista TUDO que existe no vault — pastas, categorias e tags — com
// quantos favoritos cada uma tem. Ordena por uso, e desempata pelo nome para
// a lista nao dancar a cada sync.
function facetas(valores) {
  const counts = new Map();
  for (const v of valores) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
}

function secaoBrowse(titulo, prefixo, entradas, vazio, filtro) {
  const sec = document.createElement('section');
  sec.className = 'facet';

  const h = document.createElement('h3');
  h.textContent = `${titulo} (${entradas.length})`;
  sec.append(h);
  if (filtro) sec.append(filtro);

  if (!entradas.length) {
    const p = document.createElement('p');
    p.className = 'facet-empty';
    p.textContent = vazio;
    sec.append(p);
    return sec;
  }

  for (const [nome, n] of entradas) {
    const token = prefixo + nome;
    const b = document.createElement('button');
    b.className = 'facet-row' + (tokenAtivo(token) ? ' on' : '');
    b.type = 'button';

    const label = document.createElement('span');
    label.className = 'facet-name';
    label.textContent = nome;

    const qtd = document.createElement('span');
    qtd.className = 'facet-count';
    qtd.textContent = n;

    b.append(label, qtd);
    b.onclick = () => toggleToken(token);
    sec.append(b);
  }
  return sec;
}

// `dev/k8s` e uma string so no banco; a arvore existe so na tela. O total de um
// no inclui os descendentes — clicar em `dev` filtra `dev/*` porque a busca faz
// substring no campo folder.
function arvoreDePastas(items) {
  const raiz = new Map();
  for (const b of items) {
    if (!b.folder) continue;
    let nivel = raiz;
    let caminho = '';
    for (const parte of b.folder.split('/').filter(Boolean)) {
      caminho = caminho ? `${caminho}/${parte}` : parte;
      if (!nivel.has(parte)) nivel.set(parte, { nome: parte, caminho, total: 0, filhos: new Map() });
      const no = nivel.get(parte);
      no.total += 1;
      nivel = no.filhos;
    }
  }
  return raiz;
}

function contaNos(nivel) {
  let n = 0;
  for (const no of nivel.values()) n += 1 + contaNos(no.filhos);
  return n;
}

function linhasDaArvore(nivel, profundidade, destino, filtro) {
  for (const no of [...nivel.values()].sort((a, b) => (b.total - a.total) || a.nome.localeCompare(b.nome))) {
    // Um no fica visivel se ele casa com o filtro ou se algum descendente casa.
    const eu = !filtro || VMSearch.norm(no.nome).includes(filtro);
    const galho = document.createElement('div');
    const filhos = document.createElement('div');
    if (no.filhos.size) linhasDaArvore(no.filhos, profundidade + 1, filhos, filtro);
    if (!eu && !filhos.childElementCount) continue;

    const token = '/' + no.caminho;
    const aberto = !state.pastasFechadas.has(no.caminho);

    const linha = document.createElement('div');
    linha.className = 'tree-row';
    linha.style.setProperty('--nivel', profundidade);

    if (no.filhos.size) {
      const seta = document.createElement('button');
      seta.type = 'button';
      seta.className = 'tree-toggle';
      seta.textContent = aberto ? '▾' : '▸';
      seta.title = aberto ? 'Collapse' : 'Expand';
      seta.onclick = () => {
        if (aberto) state.pastasFechadas.add(no.caminho); else state.pastasFechadas.delete(no.caminho);
        localStorage.setItem('vm_pastas_fechadas', JSON.stringify([...state.pastasFechadas]));
        renderBrowse();
      };
      linha.append(seta);
    } else {
      const vazio = document.createElement('span');
      vazio.className = 'tree-toggle vazio';
      linha.append(vazio);
    }

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'facet-row tree-item' + (tokenAtivo(token) ? ' on' : '');
    const nome = document.createElement('span');
    nome.className = 'facet-name';
    nome.textContent = no.nome;
    const qtd = document.createElement('span');
    qtd.className = 'facet-count';
    qtd.textContent = no.total;
    b.append(nome, qtd);
    b.onclick = () => toggleToken(token);
    b.title = '/' + no.caminho;
    linha.append(b);

    galho.append(linha);
    // Com filtro ativo, esconder o galho esconderia justamente o que casou.
    if (aberto || filtro) galho.append(filhos);
    destino.append(galho);
  }
}

function secaoArvore(raiz, total, filtro) {
  const sec = document.createElement('section');
  sec.className = 'facet';

  const h = document.createElement('h3');
  h.textContent = `Folders (${total})`;
  sec.append(h, campoDeFiltro('filtro-pastas', 'filter folders…', renderBrowse));

  if (!total) {
    const p = document.createElement('p');
    p.className = 'facet-empty';
    p.textContent = 'no folders yet';
    sec.append(p);
    return sec;
  }

  const arvore = document.createElement('div');
  arvore.className = 'tree';
  linhasDaArvore(raiz, 0, arvore, filtro);
  if (!arvore.childElementCount) {
    const p = document.createElement('p');
    p.className = 'facet-empty';
    p.textContent = 'no folder matches the filter';
    sec.append(p);
    return sec;
  }
  sec.append(arvore);
  return sec;
}

// Filtro da propria lista — nao mexe na busca de favoritos, so encurta o painel
// quando ha categoria/tag demais para varrer com o olho.
function campoDeFiltro(id, placeholder, aoMudar) {
  const wrap = document.createElement('div');
  wrap.className = 'facet-search';
  const input = document.createElement('input');
  input.type = 'search';
  input.id = id;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.value = state.filtroPainel[id] || '';
  input.oninput = () => { state.filtroPainel[id] = input.value; aoMudar(); };
  wrap.append(input);
  return wrap;
}

function renderBrowse() {
  const body = $('#browse-body');
  // Recriar o painel a cada render tiraria o foco de quem esta digitando no
  // filtro; guardo onde estava o cursor e devolvo no fim.
  const focado = document.activeElement;
  const focoId = focado && focado.closest?.('.facet-search') ? focado.id : null;
  const caret = focoId ? focado.selectionStart : 0;

  body.innerHTML = '';

  const raiz = arvoreDePastas(state.items);
  const tags = state.items.flatMap((b) => b.tags.split(',').filter(Boolean));
  const filtra = (lista, chave) => {
    const termo = VMSearch.norm(state.filtroPainel[chave] || '');
    return termo ? lista.filter(([nome]) => VMSearch.norm(nome).includes(termo)) : lista;
  };

  body.append(
    secaoArvore(raiz, contaNos(raiz), VMSearch.norm(state.filtroPainel['filtro-pastas'] || '')),
    secaoBrowse('Categories', '@', filtra(facetas(state.items.map((b) => b.category)), 'filtro-categorias'),
                'no categories yet', campoDeFiltro('filtro-categorias', 'filter categories…', renderBrowse)),
    secaoBrowse('Tags', '#', filtra(facetas(tags), 'filtro-tags'),
                'no tags yet', campoDeFiltro('filtro-tags', 'filter tags…', renderBrowse)),
  );

  if (focoId) {
    const alvo = document.getElementById(focoId);
    if (alvo) { alvo.focus(); alvo.setSelectionRange(caret, caret); }
  }

  $('#browse-clear').classList.toggle('hidden',
    !$('#q').value.trim() && !Object.values(state.filtroPainel).some(Boolean));
}

function setBrowseAberto(aberto) {
  $('#browse').classList.toggle('off', !aberto);
  $('#btn-browse').setAttribute('aria-expanded', String(aberto));
  localStorage.setItem('vm_browse', aberto ? '1' : '0');
}

$('#btn-browse').onclick = () => setBrowseAberto($('#browse').classList.contains('off'));
$('#browse-clear').onclick = () => {
  state.filtroPainel = {};
  setQuery('');
};

// Atalhos: categorias e tags mais usadas viram chips clicaveis.
function renderChips() {
  const counts = new Map();
  for (const b of state.items) {
    if (b.category) counts.set('@' + b.category, (counts.get('@' + b.category) || 0) + 1);
    for (const t of b.tags.split(',').filter(Boolean)) counts.set('#' + t, (counts.get('#' + t) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const wrap = $('#chips');
  wrap.innerHTML = '';
  for (const [label, n] of top) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = `${label} ${n}`;
    b.classList.toggle('on', tokenAtivo(label));
    b.onclick = () => toggleToken(label);
    wrap.append(b);
  }
}

function setQuery(v) {
  $('#q').value = v;
  state.sel = 0;
  render();
  $('#q').focus();
}

/* ---------------- acoes ---------------- */
function openSelected(newTab = true) {
  const b = state.results[state.sel];
  if (!b?.url) return;
  const url = /^https?:\/\//i.test(b.url) ? b.url : 'https://' + b.url;
  if (newTab) window.open(url, '_blank', 'noopener');
  else location.href = url;
}

function openModal(b = null) {
  state.editing = b;
  $('#modal-title').textContent = b ? 'Edit bookmark' : 'New bookmark';
  $('#b-url').value = b?.url || '';
  $('#b-title').value = b?.title || '';
  $('#b-folder').value = b?.folder || '';
  $('#b-category').value = b?.category || '';
  $('#b-tags').value = b?.tags || '';
  $('#b-description').value = b?.description || '';
  $('#bm-error').textContent = '';
  $('#bm-delete').classList.toggle('hidden', !b);
  $('#modal').classList.remove('hidden');
  ($('#b-url').value ? $('#b-title') : $('#b-url')).focus();
}

function closeModal() {
  $('#modal').classList.add('hidden');
  state.editing = null;
  $('#q').focus();
}

$('#bm-form').onsubmit = async (e) => {
  e.preventDefault();
  const payload = {
    url: $('#b-url').value.trim(),
    title: $('#b-title').value.trim(),
    folder: $('#b-folder').value.trim(),
    category: $('#b-category').value.trim(),
    tags: $('#b-tags').value.trim(),
    description: $('#b-description').value.trim(),
  };
  if (!payload.url && !payload.title) {
    $('#bm-error').textContent = 'enter at least a url or a title';
    return;
  }
  if (!payload.title) payload.title = payload.url.replace(/^https?:\/\//, '').replace(/\/$/, '');

  setSync('saving…', 'saving');
  try {
    const r = state.editing
      ? await api(`/api/bookmarks/${state.editing.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await api('/api/bookmarks', { method: 'POST', body: JSON.stringify(payload) });

    const i = state.items.findIndex((b) => b.id === r.item.id);
    if (i >= 0) state.items[i] = r.item; else state.items.unshift(r.item);
    state.lastSync = r.item.updated_at;
    refreshDatalists();
    closeModal();
    render();
    setSync('synced');
  } catch (err) {
    $('#bm-error').textContent = err.message;
    setSync('save failed', 'err');
  }
};

async function removeBookmark(b) {
  if (!b || !confirm(`Delete "${b.title || b.url}"?`)) return;
  setSync('saving…', 'saving');
  try {
    await api(`/api/bookmarks/${b.id}`, { method: 'DELETE' });
    state.items = state.items.filter((x) => x.id !== b.id);
    render();
    setSync('synced');
  } catch (err) {
    setSync('delete failed', 'err');
  }
}

$('#bm-delete').onclick = async () => {
  const b = state.editing;
  closeModal();
  await removeBookmark(b);
};
$('#bm-cancel').onclick = closeModal;
$('#btn-new').onclick = () => openModal();
$('#fab').onclick = () => openModal();
$('#q-clear').onclick = () => setQuery('');
$('#q').oninput = () => { state.sel = 0; render(); };

/* ---------------- teclado ---------------- */
document.addEventListener('keydown', (e) => {
  if (!$('#io-modal').classList.contains('hidden')) {
    if (e.key === 'Escape') fecharIo();
    return;
  }
  if (!$('#modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if ($('#app').classList.contains('hidden')) return;

  const inSearch = document.activeElement === $('#q');

  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
    e.preventDefault();
    state.sel = Math.min(state.sel + 1, state.results.length - 1);
    render();
  } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
    e.preventDefault();
    state.sel = Math.max(state.sel - 1, 0);
    render();
  } else if (e.key === 'Enter' && state.results.length) {
    e.preventDefault();
    openSelected(e.ctrlKey || e.metaKey || true);
  } else if (e.key === 'Escape') {
    if ($('#q').value) setQuery(''); else $('#q').blur();
  } else if (!inSearch && (e.key === 'n' || e.key === '/')) {
    e.preventDefault();
    if (e.key === 'n') openModal(); else $('#q').focus();
  } else if (!inSearch && e.key === 'b') {
    e.preventDefault();
    setBrowseAberto($('#browse').classList.contains('off'));
  } else if (!inSearch && e.key === 'e') {
    e.preventDefault();
    if (state.results[state.sel]) openModal(state.results[state.sel]);
  } else if (e.key === 'Delete') {
    e.preventDefault();
    removeBookmark(state.results[state.sel]);
  } else if (!inSearch && e.key.length === 1) {
    $('#q').focus();
  }
});

/* ---------------- importar / exportar ---------------- */
const io = { conteudo: '', nome: '', plano: null };

function nomeDoArquivo(res, fallback) {
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  return m ? m[1] : fallback;
}

// O download precisa passar pelo fetch porque a rota exige o header de
// autenticação — um <a href> comum iria sem token e levaria 401.
async function exportar(format) {
  const btn = document.querySelector(`[data-export="${format}"]`);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'baixando…';
  try {
    const res = await fetch(`/api/export?format=${format}`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `error ${res.status}`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nomeDoArquivo(res, `vaultmarks.${format}`);
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    $('#io-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function modoEscolhido() {
  return document.querySelector('input[name="io-mode"]:checked').value;
}

async function pedirPlano({ apply = false } = {}) {
  return api('/api/import', {
    method: 'POST',
    body: JSON.stringify({ content: io.conteudo, mode: modoEscolhido(), apply }),
  });
}

const ROTULOS = {
  criar: ['new bookmark', 'new bookmarks'],
  atualizar: ['updated bookmark', 'updated bookmarks'],
  iguais: ['already identical, no change', 'already identical, no change'],
  ignorar: ['kept as is', 'kept as is'],
  remover: ['removed from the vault', 'removed from the vault'],
};

function renderPlano(plano) {
  io.plano = plano;
  const r = plano.resumo;
  const ul = $('#io-summary');
  ul.innerHTML = '';

  for (const chave of ['criar', 'atualizar', 'ignorar', 'iguais', 'remover']) {
    const n = r[chave];
    if (!n) continue;
    const li = document.createElement('li');
    li.className = `io-line io-${chave}`;
    const exemplos = (plano.exemplos[chave] || []).slice(0, 3).join(' · ');
    li.innerHTML = `<b>${n}</b> ${ROTULOS[chave][n === 1 ? 0 : 1]}`;
    if (exemplos) li.innerHTML += `<em>${exemplos}${n > 3 ? ' …' : ''}</em>`;
    ul.append(li);
  }

  if (!ul.children.length) {
    ul.innerHTML = '<li class="io-line">nothing to do — the file already matches the vault</li>';
  }

  const aviso = $('#io-warn');
  if (r.remover) {
    aviso.textContent = `Heads up: ${r.remover} bookmark(s) in the vault are not in the file and will be removed.`;
    aviso.classList.remove('hidden');
  } else {
    aviso.classList.add('hidden');
  }

  $('#io-apply').disabled = !(r.criar || r.atualizar || r.remover);
  $('#io-apply').textContent = r.remover ? 'replace vault' : 'import';
  $('#io-plan').classList.remove('hidden');
}

async function previsualizar() {
  if (!io.conteudo) return;
  $('#io-error').textContent = '';
  try {
    renderPlano(await pedirPlano({ apply: false }));
  } catch (err) {
    $('#io-error').textContent = err.message;
    $('#io-plan').classList.add('hidden');
    $('#io-apply').disabled = true;
  }
}

function abrirIo() {
  io.conteudo = '';
  io.nome = '';
  io.plano = null;
  $('#io-file').value = '';
  $('#io-filename').textContent = 'no file chosen';
  $('#io-error').textContent = '';
  $('#io-plan').classList.add('hidden');
  $('#io-apply').disabled = true;
  $('#io-modal').classList.remove('hidden');
}

function fecharIo() {
  $('#io-modal').classList.add('hidden');
  $('#q').focus();
}

document.querySelectorAll('[data-export]').forEach((b) => {
  b.onclick = () => exportar(b.dataset.export);
});

$('#io-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  io.nome = file.name;
  $('#io-filename').textContent = file.name;
  io.conteudo = await file.text();
  await previsualizar();
};

document.querySelectorAll('input[name="io-mode"]').forEach((r) => {
  // Trocar o modo recalcula o plano: o número muda na frente do usuário.
  r.onchange = previsualizar;
});

$('#io-apply').onclick = async () => {
  const btn = $('#io-apply');
  btn.disabled = true;
  btn.textContent = 'importando…';
  setSync('importando…', 'saving');
  try {
    const r = await pedirPlano({ apply: true });
    await loadAll();
    setSync('synced');
    fecharIo();
    const n = r.resumo.criar + r.resumo.atualizar + r.resumo.remover;
    setSync(`${n} bookmark(s) changed`);
    setTimeout(() => setSync('synced'), 4000);
  } catch (err) {
    $('#io-error').textContent = err.message;
    setSync('import failed', 'err');
    btn.disabled = false;
    btn.textContent = 'import';
  }
};

$('#btn-io').onclick = abrirIo;
$('#io-close').onclick = fecharIo;

/* ---------------- pwa ---------------- */
// A tela do celular corta o placeholder longo no meio de uma palavra.
function fitPlaceholder() {
  $('#q').placeholder = window.matchMedia('(max-width: 640px)').matches
    ? 'search…  #tag  @cat  /folder'
    : 'search…  #tag  @category  /folder  -exclude';
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Service worker so existe em contexto seguro: https ou localhost. Em
  // http://<ip-da-lan> o navegador ignora — por isso o compose poe TLS.
  if (!window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Compartilhar uma pagina do navegador do celular cai aqui (share_target do
// manifest): /?url=...&title=... abre o modal ja preenchido.
function pendingShare() {
  const p = new URLSearchParams(location.search);
  const url = p.get('url') || '';
  const text = p.get('text') || '';
  const title = p.get('title') || '';
  if (!url && !text && !title) return null;

  // Android costuma mandar a URL dentro de `text` em vez de `url`.
  const fromText = /https?:\/\/\S+/.exec(text);
  return {
    url: url || (fromText ? fromText[0] : ''),
    title: title || (fromText ? text.replace(fromText[0], '').trim() : text),
  };
}

/* ---------------- boot ---------------- */
// Permite abrir direto numa busca: /#q=%23devops
function queryFromHash() {
  const m = /^#q=(.*)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : '';
}

async function enterApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await loadAll();

  const shared = pendingShare();
  if (shared) {
    openModal();
    $('#b-url').value = shared.url;
    $('#b-title').value = shared.title;
    // Limpa a query string pra um F5 nao reabrir o modal.
    history.replaceState(null, '', location.pathname);
  } else if (location.hash === '#novo') {
    openModal();
    history.replaceState(null, '', location.pathname);
  }

  const initial = queryFromHash();
  if (initial) setQuery(initial);
  window.addEventListener('hashchange', () => setQuery(queryFromHash()));
  if (!shared) $('#q').focus();
  setInterval(pullChanges, 5000);
  window.addEventListener('focus', pullChanges);
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#f-login').focus();
  checarServidor();
}

(async function boot() {
  registerServiceWorker();
  fitPlaceholder();
  window.addEventListener('resize', fitPlaceholder);
  renderAuthMode();
  // No celular o painel abre fechado: la ele empurra os resultados para baixo.
  const escolha = localStorage.getItem('vm_browse');
  setBrowseAberto(escolha === null ? window.innerWidth >= 900 : escolha === '1');
  if (!state.token) return showLogin();

  // So o token invalido derruba a sessao. Servidor fora do ar nao: apagar o
  // token ali obrigaria a digitar a senha de novo por causa de um restart.
  try {
    await api('/api/me');
  } catch (err) {
    const rede = err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(err.message || '');
    if (!rede) {
      localStorage.removeItem('vm_token');
      state.token = '';
    }
    return showLogin();
  }
  await enterApp();
})();
