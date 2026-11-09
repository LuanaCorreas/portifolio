// Meu Estúdio UGC Lite — núcleo da timeline (funções puras, sem interface).
//
// Modelo (tempos em segundos):
//   timeline = {
//     clipes:   [{id, faixa:'V'|'N', midia, ini, fim, pos, volume, mudo, vinculo?}]
//               V = take de vídeo (com seu próprio áudio)   N = narração/áudio separado
//               ini/fim = trecho usado do arquivo original;  pos = início na timeline
//               vinculo = {midia, t, desloc}: a narração começa `desloc` segundos depois
//               do instante `t` do take `midia`, onde quer que ele esteja na timeline.
//     textos:   [{id, texto, pos, dur, estilo}]
//     legendas: [{id, texto, midia, t, dur}]  ancoradas no instante `t` da mídia de origem
//               ou [{id, texto, pos, dur}]       livres
//   }
//
// Modos de sincronização ao inserir/excluir:
//   'tudo'   desloca vídeo, narração, textos e legendas livres que vêm depois
//   'video'  desloca só os takes de vídeo; narrações vinculadas acompanham o take,
//            narrações livres e textos ficam no lugar
//   'nada'   nada se desloca (sobrescreve / deixa lacuna)

export const EPS = 1e-3;

export const MODOS = {
  tudo: { nome: 'Deslocar tudo junto', desc: 'Vídeo, narração, textos e legendas que vêm depois andam juntos. Mantém tudo sincronizado.' },
  video: { nome: 'Deslocar só o vídeo', desc: 'Só os takes andam. Narrações VINCULADAS acompanham o take; narrações livres e textos ficam no lugar.' },
  nada: { nome: 'Não deslocar (sobrescrever)', desc: 'Nada se move: o novo take ocupa o lugar do que estiver embaixo; exclusões deixam um espaço vazio.' },
};

export const MIN_CLIPE = 0.1;

let contador = 0;
export function novoId(prefixo = 'c') {
  contador += 1;
  return prefixo + Date.now().toString(36).slice(-5) + contador.toString(36) + Math.random().toString(36).slice(2, 5);
}

export const dur = (c) => c.fim - c.ini;
export const fimTl = (c) => c.pos + dur(c);
const arred = (v) => Math.round(v * 1000) / 1000;

export function clonar(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function timelineVazia() {
  return { clipes: [], textos: [], legendas: [] };
}

export function normalizar(tl) {
  tl = tl || timelineVazia();
  tl.clipes = (tl.clipes || []).filter((c) => c.fim - c.ini > EPS);
  tl.textos = tl.textos || [];
  tl.legendas = tl.legendas || [];
  for (const c of tl.clipes) {
    if (c.volume === undefined) c.volume = 1;
    c.pos = Math.max(0, c.pos);
  }
  return tl;
}

export function clipesFaixa(tl, faixa) {
  return tl.clipes.filter((c) => c.faixa === faixa).sort((a, b) => a.pos - b.pos);
}

export function acharClipe(tl, id) {
  return tl.clipes.find((c) => c.id === id) || null;
}

export function duracaoTotal(tl) {
  let fim = 0;
  for (const c of tl.clipes) fim = Math.max(fim, fimTl(c));
  for (const t of tl.textos) fim = Math.max(fim, t.pos + t.dur);
  for (const l of tl.legendas) if (!l.midia) fim = Math.max(fim, l.pos + l.dur);
  return arred(fim);
}

/** Instante `t` da mídia de origem -> tempo na timeline (primeiro clipe que o contém). */
export function tlDeFonte(tl, midia, t, faixas = ['V', 'N']) {
  const lista = tl.clipes.filter((c) => c.midia === midia && faixas.includes(c.faixa)).sort((a, b) => a.pos - b.pos);
  for (const c of lista) {
    if (t >= c.ini - EPS && t < c.fim - EPS) return { pos: c.pos + (t - c.ini), limite: fimTl(c), clip: c };
  }
  return null;
}

/** Clipe da faixa que está tocando no tempo T da timeline. */
export function clipeEm(tl, faixa, T) {
  const lista = clipesFaixa(tl, faixa);
  for (let i = lista.length - 1; i >= 0; i--) {
    const c = lista[i];
    if (T >= c.pos - EPS && T < fimTl(c) - EPS) return c;
  }
  return null;
}

export function clipesEm(tl, faixa, T) {
  return clipesFaixa(tl, faixa).filter((c) => T >= c.pos - EPS && T < fimTl(c) - EPS);
}

/** Recalcula a posição das narrações vinculadas a takes de vídeo. */
export function resolverVinculos(tl) {
  for (const c of tl.clipes) {
    if (c.faixa !== 'N' || !c.vinculo) continue;
    const r = tlDeFonte(tl, c.vinculo.midia, c.vinculo.t, ['V']);
    if (r) {
      c.pos = arred(Math.max(0, r.pos + c.vinculo.desloc));
      c.vinculoPerdido = false;
    } else {
      c.vinculoPerdido = true; // o ponto de sincronização foi cortado: fica onde está
    }
  }
  return tl;
}

/** Legendas com seus tempos na timeline (as ancoradas acompanham o take). */
export function resolverLegendas(tl) {
  const saida = [];
  for (const l of tl.legendas) {
    let ini, fim;
    if (l.midia) {
      const r = tlDeFonte(tl, l.midia, l.t);
      if (!r) continue;
      ini = r.pos;
      fim = Math.min(ini + l.dur, r.limite);
    } else {
      ini = l.pos;
      fim = l.pos + l.dur;
    }
    if (fim - ini > 0.05) saida.push({ id: l.id, ini, fim, texto: l.texto, ancorada: !!l.midia });
  }
  return saida.sort((a, b) => a.ini - b.ini);
}

/** Divide os clipes das faixas indicadas que atravessam T. Devolve os novos ids. */
export function dividir(tl, T, faixas = ['V'], somenteIds = null) {
  const novos = [];
  for (const c of [...tl.clipes]) {
    if (!faixas.includes(c.faixa)) continue;
    if (somenteIds && !somenteIds.includes(c.id)) continue;
    if (T > c.pos + EPS && T < fimTl(c) - EPS) {
      const corte = c.ini + (T - c.pos);
      const b = { ...clonar(c), id: novoId(), ini: arred(corte), pos: arred(T) };
      if (b.vinculo) delete b.vinculo; // a 2ª parte de uma narração fica livre
      c.fim = arred(corte);
      tl.clipes.push(b);
      novos.push(b.id);
    }
  }
  return novos;
}

function deveDeslocar(item, tipo, modo) {
  if (modo === 'nada') return false;
  if (tipo === 'V') return true;
  if (modo !== 'tudo') return false;
  if (tipo === 'N') return !item.vinculo;
  return true; // textos e legendas livres
}

/** Desloca em `delta` tudo que começa em T ou depois, conforme o modo. */
export function deslocar(tl, T, delta, modo = 'tudo', ignorar = []) {
  if (Math.abs(delta) < EPS) return;
  for (const c of tl.clipes) {
    if (ignorar.includes(c.id)) continue;
    if (c.pos >= T - EPS && deveDeslocar(c, c.faixa, modo)) c.pos = arred(Math.max(0, c.pos + delta));
  }
  for (const t of tl.textos) {
    if (t.pos >= T - EPS && deveDeslocar(t, 'T', modo)) t.pos = arred(Math.max(0, t.pos + delta));
  }
  for (const l of tl.legendas) {
    if (!l.midia && l.pos >= T - EPS && deveDeslocar(l, 'L', modo)) l.pos = arred(Math.max(0, l.pos + delta));
  }
}

/** Remove de uma faixa tudo o que estiver entre A e B (sem deslocar nada). */
export function limparFaixa(tl, faixa, A, B, ignorar = []) {
  if (B - A < EPS) return;
  const alvos = tl.clipes.filter((c) => c.faixa === faixa && !ignorar.includes(c.id)).map((c) => c.id);
  alvos.push(...dividir(tl, A, [faixa], alvos));
  dividir(tl, B, [faixa], alvos);
  tl.clipes = tl.clipes.filter((c) => {
    if (c.faixa !== faixa || ignorar.includes(c.id)) return true;
    return !(c.pos >= A - EPS && fimTl(c) <= B + EPS);
  });
}

/**
 * Insere um trecho de take (ou vários pedaços) na posição T.
 * pedacos: [{ini, fim}] do mesmo arquivo — usado para inserir já sem os cortes aprovados.
 */
export function inserirTake(tl, { midia, faixa = 'V', pedacos, volume = 1 }, T, modo = 'tudo') {
  const total = pedacos.reduce((s, p) => s + (p.fim - p.ini), 0);
  if (total < EPS) return [];
  T = Math.max(0, T);
  if (faixa === 'N') {
    // narração: não empurra nada, só é colocada (pode sobrepor outras narrações)
    let p = T;
    return pedacos.map((pd) => {
      const c = { id: novoId(), faixa: 'N', midia, ini: arred(pd.ini), fim: arred(pd.fim), pos: arred(p), volume };
      p += pd.fim - pd.ini;
      tl.clipes.push(c);
      return c.id;
    });
  }
  if (modo === 'nada') {
    limparFaixa(tl, 'V', T, T + total);
  } else {
    dividir(tl, T, ['V']);
    deslocar(tl, T, total, modo);
  }
  let p = T;
  const ids = [];
  for (const pd of pedacos) {
    const c = { id: novoId(), faixa: 'V', midia, ini: arred(pd.ini), fim: arred(pd.fim), pos: arred(p), volume };
    tl.clipes.push(c);
    ids.push(c.id);
    p += pd.fim - pd.ini;
  }
  resolverVinculos(tl);
  return ids;
}

/** Exclui o trecho [A, B] da timeline. */
export function excluirTrecho(tl, A, B, modo = 'tudo') {
  if (B - A < EPS) return 0;
  limparFaixa(tl, 'V', A, B);
  if (modo === 'tudo') {
    // narrações livres sob o trecho também saem (é uma exclusão de trecho)
    const vinculadas = tl.clipes.filter((x) => x.faixa === 'N' && x.vinculo).map((x) => x.id);
    limparFaixa(tl, 'N', A, B, vinculadas);
    tl.textos = tl.textos.filter((t) => !(t.pos >= A - EPS && t.pos + t.dur <= B + EPS));
    for (const t of tl.textos) {
      if (t.pos < A && t.pos + t.dur > A) t.dur = arred(Math.max(MIN_CLIPE, t.dur - Math.min(B, t.pos + t.dur) + A));
    }
    tl.legendas = tl.legendas.filter((l) => l.midia || !(l.pos >= A - EPS && l.pos + l.dur <= B + EPS));
  }
  if (modo !== 'nada') deslocar(tl, B, -(B - A), modo);
  resolverVinculos(tl);
  return B - A;
}

/** Remove um intervalo do ARQUIVO de origem em todos os clipes que o usam (cortes aprovados). */
export function removerIntervaloFonte(tl, midia, a, b, modo = 'tudo') {
  let removido = 0;
  const alvos = tl.clipes.filter((c) => c.faixa === 'V' && c.midia === midia).sort((x, y) => y.pos - x.pos);
  for (const c of alvos) {
    if (!tl.clipes.includes(c)) continue;
    const i0 = Math.max(a, c.ini);
    const i1 = Math.min(b, c.fim);
    if (i1 - i0 < EPS) continue;
    const A = c.pos + (i0 - c.ini);
    const B = c.pos + (i1 - c.ini);
    removido += excluirTrecho(tl, A, B, modo);
  }
  return removido;
}

/** Pedaços de um trecho de origem descontando intervalos a cortar. */
export function pedacosSemCortes(ini, fim, cortes) {
  let pedacos = [{ ini, fim }];
  for (const [a, b] of cortes) {
    const novos = [];
    for (const p of pedacos) {
      if (b <= p.ini || a >= p.fim) { novos.push(p); continue; }
      if (a > p.ini) novos.push({ ini: p.ini, fim: a });
      if (b < p.fim) novos.push({ ini: b, fim: p.fim });
    }
    pedacos = novos;
  }
  return pedacos.filter((p) => p.fim - p.ini >= MIN_CLIPE);
}

/** Exclui clipes; com fecharEspaco, o que vem depois "anda para trás". */
export function excluirClipes(tl, ids, fecharEspaco = false, modo = 'tudo') {
  const alvos = tl.clipes.filter((c) => ids.includes(c.id)).sort((a, b) => b.pos - a.pos);
  for (const c of alvos) {
    tl.clipes = tl.clipes.filter((x) => x.id !== c.id);
    if (fecharEspaco && c.faixa === 'V') {
      const outroNoMesmoLugar = tl.clipes.some((x) => x.faixa === 'V' && x.pos < fimTl(c) - EPS && fimTl(x) > c.pos + EPS);
      if (!outroNoMesmoLugar) deslocar(tl, fimTl(c), -dur(c), modo);
    }
  }
  resolverVinculos(tl);
}

/** Move um clipe. Takes de vídeo sobrescrevem o que estiver por baixo. */
export function moverClipe(tl, id, novaPos) {
  const c = acharClipe(tl, id);
  if (!c) return;
  novaPos = arred(Math.max(0, novaPos));
  if (c.faixa === 'N') {
    if (c.vinculo) c.vinculo.desloc = arred(c.vinculo.desloc + (novaPos - c.pos));
    c.pos = novaPos;
    return;
  }
  c.pos = novaPos;
  limparFaixa(tl, 'V', novaPos, novaPos + dur(c), [id]);
  resolverVinculos(tl);
}

/** Reorganiza: troca o take com o vizinho da esquerda (-1) ou da direita (+1). */
export function trocarOrdem(tl, id, direcao) {
  const lista = clipesFaixa(tl, 'V');
  const i = lista.findIndex((c) => c.id === id);
  const j = i + direcao;
  if (i < 0 || j < 0 || j >= lista.length) return false;
  const [a, b] = direcao < 0 ? [lista[j], lista[i]] : [lista[i], lista[j]];
  const lacuna = b.pos - fimTl(a);
  const inicio = a.pos;
  b.pos = arred(inicio);
  a.pos = arred(inicio + dur(b) + Math.max(0, lacuna));
  resolverVinculos(tl);
  return true;
}

/** Ajusta a borda de um clipe para o tempo T da timeline (sem deslocar os vizinhos). */
export function aparar(tl, id, lado, T, duracaoMidia = Infinity) {
  const c = acharClipe(tl, id);
  if (!c) return;
  if (lado === 'ini') {
    let novoIni = c.ini + (T - c.pos);
    novoIni = Math.max(0, Math.min(novoIni, c.fim - MIN_CLIPE));
    const delta = novoIni - c.ini;
    c.ini = arred(novoIni);
    c.pos = arred(Math.max(0, c.pos + delta));
  } else {
    let novoFim = c.ini + (T - c.pos);
    novoFim = Math.min(duracaoMidia, Math.max(novoFim, c.ini + MIN_CLIPE));
    c.fim = arred(novoFim);
  }
  if (c.faixa === 'V') limparFaixa(tl, 'V', c.pos, fimTl(c), [id]);
  resolverVinculos(tl);
}

/** Define a duração de um clipe; com empurrar=true os seguintes acompanham. */
export function definirDuracao(tl, id, novaDur, duracaoMidia = Infinity, empurrar = true, modo = 'tudo') {
  const c = acharClipe(tl, id);
  if (!c) return;
  const antes = dur(c);
  const fimAntigo = fimTl(c);
  c.fim = arred(Math.min(duracaoMidia, Math.max(c.ini + MIN_CLIPE, c.ini + novaDur)));
  const delta = dur(c) - antes;
  if (c.faixa === 'V') {
    if (empurrar) deslocar(tl, fimAntigo, delta, modo, [id]);
    else limparFaixa(tl, 'V', c.pos, fimTl(c), [id]);
  }
  resolverVinculos(tl);
}

/** Fecha os espaços vazios entre takes de vídeo. */
export function fecharLacunas(tl, modo = 'tudo') {
  let fim = 0;
  for (const c of clipesFaixa(tl, 'V')) {
    if (c.pos > fim + EPS) deslocar(tl, c.pos, fim - c.pos, modo);
    fim = Math.max(fim, fimTl(c));
  }
  resolverVinculos(tl);
}

/** Vincula uma narração ao take que está tocando no tempo T (ponto de sincronização). */
export function vincular(tl, idNarracao, T) {
  const n = acharClipe(tl, idNarracao);
  if (!n || n.faixa !== 'N') return false;
  let v = clipeEm(tl, 'V', T);
  if (!v) v = clipeEm(tl, 'V', n.pos);
  if (!v) return false;
  const Tref = T >= v.pos && T < fimTl(v) ? T : n.pos;
  n.vinculo = { midia: v.midia, t: arred(v.ini + (Tref - v.pos)), desloc: arred(n.pos - Tref) };
  n.vinculoPerdido = false;
  return true;
}

export function desvincular(tl, idNarracao) {
  const n = acharClipe(tl, idNarracao);
  if (n) { delete n.vinculo; delete n.vinculoPerdido; }
}

/** Ajuste fino da sincronização de uma narração (mantém o vínculo). */
export function ajustarSinc(tl, idNarracao, delta) {
  const n = acharClipe(tl, idNarracao);
  if (!n) return;
  moverClipe(tl, idNarracao, n.pos + delta);
}

// ------------------------------------------------------------ cobertura de áudio/vídeo

function uniao(intervalos) {
  const ord = intervalos.filter(([a, b]) => b - a > EPS).sort((x, y) => x[0] - y[0]);
  const saida = [];
  for (const [a, b] of ord) {
    const u = saida[saida.length - 1];
    if (u && a <= u[1] + EPS) u[1] = Math.max(u[1], b);
    else saida.push([a, b]);
  }
  return saida;
}

function subtrair(base, menos) {
  let res = base.map((x) => [...x]);
  for (const [a, b] of menos) {
    const novo = [];
    for (const [x, y] of res) {
      if (b <= x || a >= y) { novo.push([x, y]); continue; }
      if (a > x) novo.push([x, a]);
      if (b < y) novo.push([b, y]);
    }
    res = novo;
  }
  return res.filter(([x, y]) => y - x > 0.05);
}

/**
 * Onde há áudio sem vídeo (tela preta com som) e vídeo sem áudio (imagem muda).
 * midias: {id: {tem_audio, analise:{silencios:[[a,b]]}}}
 */
export function cobertura(tl, midias = {}) {
  const video = uniao(tl.clipes.filter((c) => c.faixa === 'V').map((c) => [c.pos, fimTl(c)]));
  const audio = [];
  for (const c of tl.clipes) {
    const m = midias[c.midia] || {};
    if (c.mudo || c.volume <= 0 || m.tem_audio === false) continue;
    let trechos = [[c.ini, c.fim]];
    const sil = (m.analise && m.analise.silencios) || [];
    trechos = subtrair(trechos, sil);
    for (const [a, b] of trechos) audio.push([c.pos + (a - c.ini), c.pos + (b - c.ini)]);
  }
  const audioU = uniao(audio);
  return {
    audioSemVideo: subtrair(audioU, video),
    videoSemAudio: subtrair(video, audioU),
    lacunas: subtrair(uniao([[0, duracaoTotal(tl)]]), video),
  };
}

// ------------------------------------------------------------ histórico (desfazer/refazer)

export class Historico {
  constructor(estado, limite = 150) {
    this.estado = clonar(estado);
    this.passado = [];
    this.futuro = [];
    this.limite = limite;
    this.ouvintes = [];
  }

  /** Aplica uma alteração registrando-a para desfazer. */
  editar(descricao, funcao) {
    const antes = JSON.stringify(this.estado);
    const novo = JSON.parse(antes);
    const r = funcao(novo);
    if (r === false) return false;
    if (JSON.stringify(novo) === antes) return false;
    this.passado.push({ descricao, estado: antes });
    if (this.passado.length > this.limite) this.passado.shift();
    this.futuro = [];
    this.estado = novo;
    this.avisar(descricao);
    return true;
  }

  desfazer() {
    const p = this.passado.pop();
    if (!p) return null;
    this.futuro.push({ descricao: p.descricao, estado: JSON.stringify(this.estado) });
    this.estado = JSON.parse(p.estado);
    this.avisar('Desfazer: ' + p.descricao);
    return p.descricao;
  }

  refazer() {
    const f = this.futuro.pop();
    if (!f) return null;
    this.passado.push({ descricao: f.descricao, estado: JSON.stringify(this.estado) });
    this.estado = JSON.parse(f.estado);
    this.avisar('Refazer: ' + f.descricao);
    return f.descricao;
  }

  podeDesfazer() { return this.passado.length > 0; }
  podeRefazer() { return this.futuro.length > 0; }
  proximoDesfazer() { return this.passado.length ? this.passado[this.passado.length - 1].descricao : ''; }
  proximoRefazer() { return this.futuro.length ? this.futuro[this.futuro.length - 1].descricao : ''; }
  aoMudar(fn) { this.ouvintes.push(fn); }
  avisar(d) { for (const fn of this.ouvintes) fn(d); }
}

export function formatarTempo(s, comFrames = false) {
  if (!isFinite(s)) s = 0;
  const neg = s < 0;
  s = Math.abs(s);
  const m = Math.floor(s / 60);
  const seg = Math.floor(s % 60);
  let txt = `${m}:${String(seg).padStart(2, '0')}`;
  if (comFrames) txt += '.' + String(Math.floor((s % 1) * 10));
  return (neg ? '-' : '') + txt;
}
