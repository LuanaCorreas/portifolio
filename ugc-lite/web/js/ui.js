// Utilitários de interface: criação de elementos, avisos, modais, ícones e API.

export function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, valor] of Object.entries(v)) {
        if (prop.startsWith('--')) e.style.setProperty(prop, valor); else e.style[prop] = valor;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat(Infinity)) {
    if (f === null || f === undefined || f === false) continue;
    e.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return e;
}

const ICONES = {
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h4v16H7zM14 4h4v16h-4z" fill="currentColor" stroke="none"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  pasta: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  lixo: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  desfazer: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  refazer: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  tesoura: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
  zoomMais: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  zoomMenos: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
  ajustar: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  ia: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  texto: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  esquerda: '<path d="M15 18l-6-6 6-6"/>',
  direita: '<path d="M9 18l6-6-6-6"/>',
  inicio: '<path d="M6 5v14M18 6l-8 6 8 6z"/>',
  fim: '<path d="M18 5v14M6 6l8 6-8 6z"/>',
  baixar: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  audio: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
  ima: '<path d="M6 3v8a6 6 0 0 0 12 0V3M6 7h4M14 7h4"/>',
  lacuna: '<path d="M4 12h4M16 12h4M9 8l3 4-3 4M15 8l-3 4 3 4"/>',
  olho: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  mudo: '<path d="M11 5L6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6"/>',
  som: '<path d="M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  editar: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};

export function icone(nome, extra = '') {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICONES[nome] || ''}</svg>`;
}

export function botao(texto, aoClicar, { classe = '', ic = null, titulo = null, desativado = false } = {}) {
  const b = el('button', { class: 'btn ' + classe, type: 'button', title: titulo || undefined, disabled: desativado });
  b.innerHTML = (ic ? icone(ic) : '') + (texto ? `<span>${escapar(texto)}</span>` : '');
  if (aoClicar) b.addEventListener('click', aoClicar);
  return b;
}

export function escapar(t) {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------ avisos
export function aviso(texto, tipo = 'info', ms = 4500) {
  const caixa = document.getElementById('avisos');
  const a = el('div', { class: 'toast ' + tipo, role: tipo === 'erro' ? 'alert' : 'status' }, texto);
  caixa.append(a);
  setTimeout(() => a.remove(), tipo === 'erro' ? Math.max(ms, 8000) : ms);
  a.addEventListener('click', () => a.remove());
}

// ------------------------------------------------ modais
export function modal({ titulo, corpo, botoes = [], largo = false, aoFechar = null }) {
  const fundo = el('div', { class: 'modal-fundo' });
  const caixa = el('div', { class: 'modal' + (largo ? ' largo' : ''), role: 'dialog', 'aria-modal': 'true' });
  const fechar = () => { fundo.remove(); document.removeEventListener('keydown', esc, true); aoFechar && aoFechar(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); fechar(); } };
  document.addEventListener('keydown', esc, true);
  const cab = el('div', { class: 'modal-cab' }, el('h2', {}, titulo));
  const x = botao('', fechar, { classe: 'fantasma icone', ic: 'x', titulo: 'Fechar' });
  cab.append(x);
  const corpoEl = el('div', { class: 'modal-corpo' });
  if (typeof corpo === 'string') corpoEl.innerHTML = corpo; else if (corpo) corpoEl.append(corpo);
  const rodape = el('div', { class: 'modal-rodape' });
  for (const b of botoes) {
    rodape.append(botao(b.texto, async () => {
      const r = b.acao ? await b.acao() : undefined;
      if (r !== false) fechar();
    }, { classe: b.classe || '' }));
  }
  caixa.append(cab, corpoEl);
  if (botoes.length) caixa.append(rodape);
  fundo.append(caixa);
  fundo.addEventListener('mousedown', (e) => { if (e.target === fundo) fechar(); });
  document.body.append(fundo);
  return { fechar, corpo: corpoEl, caixa };
}

export function confirmar(titulo, mensagem, { sim = 'Confirmar', perigo = false } = {}) {
  return new Promise((resolve) => {
    let resp = false;
    modal({
      titulo, corpo: el('p', { class: 'muted' }, mensagem),
      botoes: [
        { texto: 'Cancelar' },
        { texto: sim, classe: perigo ? 'perigo' : 'primario', acao: () => { resp = true; } },
      ],
      aoFechar: () => resolve(resp),
    });
  });
}

// ------------------------------------------------ API
export class ErroApi extends Error {}

export async function api(caminho, { metodo = 'GET', dados, keepalive = false } = {}) {
  let r;
  try {
    r = await fetch(caminho, {
      method: metodo,
      headers: dados !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: dados !== undefined ? JSON.stringify(dados) : undefined,
      keepalive,
    });
  } catch (e) {
    throw new ErroApi('Não foi possível falar com o aplicativo. Verifique se a janela do Meu Estúdio UGC Lite ainda está aberta.');
  }
  let corpo = null;
  try { corpo = await r.json(); } catch { /* vazio */ }
  if (!r.ok) throw new ErroApi((corpo && corpo.erro) || `Erro ${r.status}`);
  return corpo;
}

/** Envia um arquivo mostrando progresso. O navegador lê o arquivo aos poucos (pouca memória). */
export function enviarArquivo(pid, arquivo, aoProgresso) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projetos/${pid}/importar`);
    xhr.setRequestHeader('X-Nome', encodeURIComponent(arquivo.name));
    const tipo = arquivo.type.startsWith('audio') ? 'audio' : arquivo.type.startsWith('video') ? 'video' : '';
    if (tipo) xhr.setRequestHeader('X-Tipo', tipo);
    xhr.upload.onprogress = (e) => e.lengthComputable && aoProgresso && aoProgresso(e.loaded / e.total);
    xhr.onload = () => {
      let corpo = null;
      try { corpo = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(corpo);
      else reject(new ErroApi((corpo && corpo.erro) || `Falha ao enviar ${arquivo.name}`));
    };
    xhr.onerror = () => reject(new ErroApi(`Falha ao enviar ${arquivo.name}. O aplicativo foi fechado?`));
    xhr.send(arquivo);
  });
}

export function tamanhoLegivel(bytes) {
  if (!bytes) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}

export function dataLegivel(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function duracaoLegivel(s) {
  if (!s && s !== 0) return '—';
  s = Math.round(s);
  const m = Math.floor(s / 60);
  return m ? `${m}min ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
