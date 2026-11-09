// Timeline visual: faixas separadas de vídeo (V1), áudio dos takes (A1),
// narração (A2), textos (T) e legendas (L); régua, barra de sincronia,
// arrastar/aparar clipes, encaixe magnético, zoom e seleção de trecho.
import * as LT from './linha_tempo.js';
import { el, botao } from './ui.js';
import { MODOS } from './linha_tempo.js';

const FAIXAS = [
  { id: 'V', nome: 'Vídeo', sigla: 'V1', h: 54, cor: 'var(--cor-video)' },
  { id: 'A', nome: 'Áudio takes', sigla: 'A1', h: 34, cor: 'var(--cor-audio)' },
  { id: 'N', nome: 'Narração', sigla: 'A2', h: 40, cor: 'var(--cor-narracao)' },
  { id: 'T', nome: 'Textos', sigla: 'T', h: 28, cor: 'var(--cor-texto)' },
  { id: 'L', nome: 'Legendas', sigla: 'L', h: 28, cor: 'var(--cor-legenda)' },
];
const ENCAIXE_PX = 8;

export class TimelineUI {
  constructor(ed, raiz) {
    this.ed = ed;
    this.raiz = raiz;
    this.montar();
  }

  get zoom() { return this.ed.zoom; }

  montar() {
    const ed = this.ed;
    this.selModo = el('select', { title: 'O que acontece com o que vem depois quando você insere ou exclui algo' },
      ...Object.entries(MODOS).map(([v, m]) => el('option', { value: v }, m.nome)));
    this.selModo.addEventListener('change', () => ed.definirModo(this.selModo.value));
    this.barra = el('div', { class: 'tl-barra' },
      botao('Dividir', () => ed.dividirNoCursor(), { classe: 'peq', ic: 'tesoura', titulo: 'Dividir no cursor (S)' }),
      botao('Excluir', () => ed.excluirSelecao(false), { classe: 'peq', ic: 'lixo', titulo: 'Excluir seleção (Del)' }),
      botao('Excluir e juntar', () => ed.excluirSelecao(true), { classe: 'peq', titulo: 'Excluir e fechar o espaço (Shift+Del)' }),
      botao('Fechar espaços', () => ed.editar('Fechar espaços vazios', (tl) => LT.fecharLacunas(tl, ed.modo)), { classe: 'peq', ic: 'lacuna', titulo: 'Junta os takes removendo espaços vazios' }),
      el('span', { class: 'sep' }),
      el('span', { class: 'fraco rot-modo' }, 'Ao inserir/excluir:'), this.selModo,
      el('span', { class: 'sep' }),
      botao('Texto', () => ed.adicionarTexto(), { classe: 'peq', ic: 'texto', titulo: 'Adicionar texto no cursor' }),
      this.btTrecho = botao('Excluir trecho marcado', () => ed.excluirTrecho(), { classe: 'peq perigo oculto', ic: 'tesoura', titulo: 'Exclui o trecho azul (X). Esc desmarca.' }),
      el('div', { class: 'cresce' }),
      el('div', { class: 'legenda-cores' },
        el('span', {}, el('i', { style: { background: 'var(--perigo)' } }), 'áudio sem vídeo'),
        el('span', {}, el('i', { style: { background: 'var(--ambar)' } }), 'vídeo sem áudio'),
        el('span', {}, el('i', { style: { background: 'var(--ambar)', height: '3px' } }), 'sugestão da IA')),
      el('span', { class: 'sep' }),
      botao('', () => this.definirZoom(this.zoom / 1.4), { classe: 'icone peq fantasma', ic: 'zoomMenos', titulo: 'Reduzir (−)' }),
      botao('', () => this.definirZoom(this.zoom * 1.4), { classe: 'icone peq fantasma', ic: 'zoomMais', titulo: 'Ampliar (+)' }),
      botao('', () => this.ajustarZoom(), { classe: 'icone peq fantasma', ic: 'ajustar', titulo: 'Mostrar tudo' }));

    const cabecas = el('div', { class: 'tl-cabecas' }, el('div', { style: { height: '37px', borderBottom: '1px solid var(--borda)' } }));
    for (const f of FAIXAS) {
      cabecas.append(el('div', { class: 'tl-cabeca', style: { '--h': f.h + 'px' } }, el('b', { style: { background: f.cor } }, f.sigla), f.nome));
    }
    this.cabecas = cabecas;
    this.rolagem = el('div', { class: 'tl-rolagem' });
    this.conteudo = el('div', { class: 'tl-conteudo' });
    this.rolagem.append(this.conteudo);
    this.rolagem.addEventListener('scroll', () => { cabecas.scrollTop = this.rolagem.scrollTop; });
    this.rolagem.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const x = e.clientX - this.rolagem.getBoundingClientRect().left + this.rolagem.scrollLeft;
        const t = x / this.zoom;
        this.definirZoom(this.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), t, e.clientX - this.rolagem.getBoundingClientRect().left);
      } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        this.rolagem.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    this.raiz.append(this.barra, el('div', { class: 'tl-corpo' }, cabecas, this.rolagem));
  }

  definirZoom(z, ancoraT = null, ancoraX = null) {
    z = Math.max(8, Math.min(500, z));
    if (ancoraT === null) {
      ancoraT = this.ed.player.tempo;
      ancoraX = ancoraT * this.zoom - this.rolagem.scrollLeft;
    }
    this.ed.zoom = z;
    this.render();
    this.rolagem.scrollLeft = Math.max(0, ancoraT * z - ancoraX);
    this.ed.agendarSalvar();
  }

  ajustarZoom() {
    const total = Math.max(5, LT.duracaoTotal(this.ed.tl));
    this.ed.zoom = Math.max(8, Math.min(500, (this.rolagem.clientWidth - 40) / total));
    this.render();
    this.rolagem.scrollLeft = 0;
  }

  x(t) { return t * this.zoom; }
  tDeEvento(e) {
    const r = this.conteudo.getBoundingClientRect();
    return Math.max(0, (e.clientX - r.left) / this.zoom);
  }

  // ------------------------------------------------------------------ desenho
  render() {
    const ed = this.ed;
    const tl = ed.tl;
    const midias = ed.midias();
    this.selModo.value = ed.modo;
    this.btTrecho.classList.toggle('oculto', !ed.trecho);
    const total = LT.duracaoTotal(tl);
    const largura = Math.max(this.rolagem.clientWidth || 800, this.x(total + 15));
    const c = this.conteudo;
    c.innerHTML = '';
    c.style.width = largura + 'px';

    // régua
    const regua = el('div', { class: 'tl-regua' });
    const passo = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((p) => p * this.zoom >= 70) || 300;
    for (let t = 0; this.x(t) < largura; t += passo) {
      regua.append(el('div', { class: 'marca-t', style: { left: this.x(t) + 'px' } }, LT.formatarTempo(t, passo < 1)));
      const meio = t + passo / 2;
      regua.append(el('div', { class: 'marca-t menor', style: { left: this.x(meio) + 'px' } }));
    }
    regua.addEventListener('pointerdown', (e) => this.arrastarRegua(e));
    c.append(regua);

    // barra de sincronia
    const sinc = el('div', { class: 'tl-sinc', title: 'Vermelho: áudio sem vídeo · Laranja: vídeo sem áudio · Listrado: espaço vazio' });
    const cob = LT.cobertura(tl, midias);
    const faixaSinc = (lista, classe, titulo) => lista.forEach(([a, b]) => sinc.append(el('i', { class: classe, title: `${titulo}: ${LT.formatarTempo(a, true)}–${LT.formatarTempo(b, true)}`, style: { left: this.x(a) + 'px', width: Math.max(2, this.x(b - a)) + 'px' } })));
    faixaSinc(cob.lacunas, 'lac', 'Espaço vazio');
    faixaSinc(cob.videoSemAudio, 'vsa', 'Vídeo sem áudio');
    faixaSinc(cob.audioSemVideo, 'asv', 'Áudio sem vídeo');
    c.append(sinc);

    this.faixas = {};
    for (const f of FAIXAS) {
      const faixa = el('div', { class: 'tl-faixa', style: { '--h': f.h + 'px' }, 'data-faixa': f.id });
      faixa.addEventListener('pointerdown', (e) => {
        if (e.target !== faixa) return;
        ed.selecionar(null);
        ed.irPara(this.tDeEvento(e));
      });
      this.prepararSoltar(faixa, f.id);
      this.faixas[f.id] = faixa;
      c.append(faixa);
    }

    // clipes de vídeo + espelho de áudio
    for (const clip of LT.clipesFaixa(tl, 'V')) {
      const m = midias[clip.midia] || {};
      this.faixas.V.append(this.noClipe(clip, 'V', m.nome || '?', m));
      const mudo = clip.mudo || clip.volume <= 0 || m.tem_audio === false;
      this.faixas.A.append(this.noClipe(clip, 'A', mudo ? 'sem som' : `${Math.round((clip.volume ?? 1) * 100)}%`, m, mudo));
    }
    for (const clip of LT.clipesFaixa(tl, 'N')) {
      const m = midias[clip.midia] || {};
      this.faixas.N.append(this.noClipe(clip, 'N', m.nome || '?', m));
    }
    for (const t of tl.textos) {
      this.faixas.T.append(this.noItem({ id: t.id, pos: t.pos, dur: t.dur, rot: t.texto, tipo: 'T' }));
    }
    for (const l of LT.resolverLegendas(tl)) {
      this.faixas.L.append(this.noItem({ id: l.id, pos: l.ini, dur: l.fim - l.ini, rot: l.texto, tipo: 'L' }));
    }
    // marcas das sugestões pendentes da IA sobre os takes
    const sugs = ed.sugestoes().filter((s) => s.status === 'pendente' && s.acao !== 'revisar');
    for (const clip of LT.clipesFaixa(tl, 'V')) {
      for (const s of sugs) {
        if (s.midia !== clip.midia) continue;
        const a = Math.max(s.ini, clip.ini);
        const b = Math.min(s.fim, clip.fim);
        if (b - a < 0.05) continue;
        this.faixas.V.append(el('div', { class: 'marca-sug' + (s.acao === 'manter' ? ' manter' : ''), title: s.motivo,
          style: { left: this.x(clip.pos + a - clip.ini) + 'px', width: Math.max(2, this.x(b - a)) + 'px' } }));
      }
    }
    // seleção de trecho e cursor
    if (ed.trecho) {
      const { a, b } = ed.trecho;
      c.append(el('div', { class: 'selecao-trecho', style: { left: this.x(a) + 'px', width: this.x(b - a) + 'px' } }));
    }
    this.cursor = el('div', { class: 'cursor-tl' });
    c.append(this.cursor);
    this.moverCursor(ed.player ? ed.player.tempo : 0, false);
    this.marcarSelecao();
  }

  noClipe(clip, tipo, rotulo, m, mudo = false) {
    const w = Math.max(2, this.x(LT.dur(clip)));
    const no = el('div', {
      class: `clipe ${tipo}${mudo ? ' mudo' : ''}${clip.vinculoPerdido ? ' perdido' : ''}`,
      style: { left: this.x(clip.pos) + 'px', width: w + 'px' },
      'data-id': clip.id, title: `${rotulo}\n${LT.formatarTempo(clip.ini, true)}–${LT.formatarTempo(clip.fim, true)} do arquivo · ${LT.dur(clip).toFixed(2)}s`,
    });
    if (tipo === 'V' && m.tira) {
      const D = m.duracao || LT.dur(clip);
      no.append(el('div', { class: 'tira', style: {
        backgroundImage: `url("/arquivo/${this.ed.pid}/${clip.midia}/tira")`,
        backgroundSize: `${this.x(D)}px 100%`, backgroundPosition: `${-this.x(clip.ini)}px 0`, backgroundRepeat: 'no-repeat',
      } }));
    }
    if ((tipo === 'A' || tipo === 'N') && m.onda && !mudo) {
      const cv = el('canvas');
      no.append(cv);
      this.desenharOnda(cv, clip, m, w);
    }
    no.append(el('div', { class: 'rot' }, rotulo));
    if (tipo === 'N' && clip.vinculo) no.append(el('span', { class: 'vinc', title: 'Vinculada ao vídeo' }, '🔗'));
    if (tipo !== 'A') {
      no.append(el('div', { class: 'borda e', 'data-lado': 'ini' }), el('div', { class: 'borda d', 'data-lado': 'fim' }));
    }
    no.addEventListener('pointerdown', (e) => this.arrastarClipe(e, clip.id, tipo, no));
    no.addEventListener('dblclick', () => this.ed.irPara(clip.pos + 0.001));
    return no;
  }

  noItem({ id, pos, dur, rot, tipo }) {
    const no = el('div', { class: `clipe ${tipo}`, 'data-id': id, title: rot, style: { left: this.x(pos) + 'px', width: Math.max(2, this.x(dur)) + 'px' } },
      el('div', { class: 'rot' }, rot), el('div', { class: 'borda e', 'data-lado': 'ini' }), el('div', { class: 'borda d', 'data-lado': 'fim' }));
    no.addEventListener('pointerdown', (e) => this.arrastarItem(e, id, tipo, no, pos, dur));
    no.addEventListener('dblclick', () => this.ed.irPara(pos + 0.001));
    return no;
  }

  async desenharOnda(cv, clip, m, w) {
    const dados = await this.carregarOnda(clip.midia);
    if (!dados || !cv.isConnected) return;
    const h = cv.clientHeight || 34;
    const larg = Math.min(4000, Math.ceil(w));
    cv.width = larg;
    cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    const picos = dados.picos;
    const ps = dados.por_seg;
    const durc = LT.dur(clip);
    for (let x = 0; x < larg; x++) {
      const t0 = clip.ini + (x / larg) * durc;
      const t1 = clip.ini + ((x + 1) / larg) * durc;
      let mx = 0;
      for (let i = Math.floor(t0 * ps); i <= Math.floor(t1 * ps) && i < picos.length; i++) mx = Math.max(mx, picos[i]);
      const a = (mx / 100) * (h - 4) * Math.min(1, clip.volume ?? 1);
      ctx.fillRect(x, (h - a) / 2, 1, Math.max(1, a));
    }
  }

  carregarOnda(mid) {
    if (!this.ed.ondas[mid]) {
      this.ed.ondas[mid] = fetch(`/arquivo/${this.ed.pid}/${mid}/onda`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    return this.ed.ondas[mid];
  }

  marcarSelecao() {
    const s = this.ed.selecao;
    this.conteudo.querySelectorAll('.clipe').forEach((n) => n.classList.toggle('selecionado', !!s && n.dataset.id === s.id));
  }

  moverCursor(t, rolar = true) {
    if (!this.cursor) return;
    const x = this.x(t);
    this.cursor.style.left = x + 'px';
    if (rolar && this.ed.player?.tocando) {
      const r = this.rolagem;
      if (x > r.scrollLeft + r.clientWidth - 60 || x < r.scrollLeft) r.scrollLeft = x - 80;
    }
  }

  marcarTrecho(lado, t) {
    const ed = this.ed;
    const atual = ed.trecho || { a: t, b: t };
    if (lado === 'a') atual.a = t; else atual.b = t;
    if (atual.b < atual.a) [atual.a, atual.b] = [atual.b, atual.a];
    ed.trecho = atual.b - atual.a > 0.02 ? atual : null;
    if (!ed.trecho && lado === 'a') ed.trecho = { a: t, b: t + 0.0001 };
    this.render();
  }

  // ------------------------------------------------------------------ interação
  pontosEncaixe(ignorar) {
    const pts = [0, this.ed.player.tempo];
    for (const c of this.ed.tl.clipes) {
      if (c.id === ignorar) continue;
      pts.push(c.pos, LT.fimTl(c));
    }
    for (const t of this.ed.tl.textos) if (t.id !== ignorar) pts.push(t.pos, t.pos + t.dur);
    return pts;
  }

  encaixar(t, pts, guia) {
    let melhor = null;
    for (const p of pts) {
      if (Math.abs(p - t) * this.zoom <= ENCAIXE_PX && (melhor === null || Math.abs(p - t) < Math.abs(melhor - t))) melhor = p;
    }
    if (guia) {
      guia.style.display = melhor === null ? 'none' : 'block';
      if (melhor !== null) guia.style.left = this.x(melhor) + 'px';
    }
    return melhor;
  }

  arrastarRegua(e) {
    const ed = this.ed;
    e.preventDefault();
    const t0 = this.tDeEvento(e);
    const selecionar = e.shiftKey;
    ed.irPara(t0);
    if (selecionar) this.conteudo.querySelector('.selecao-trecho')?.remove();
    const sel = selecionar ? el('div', { class: 'selecao-trecho' }) : null;
    if (sel) this.conteudo.append(sel);
    const mover = (ev) => {
      const t = this.tDeEvento(ev);
      if (sel) {
        const a = Math.min(t0, t);
        const b = Math.max(t0, t);
        sel.style.left = this.x(a) + 'px';
        sel.style.width = this.x(b - a) + 'px';
        ed.trecho = b - a > 0.05 ? { a, b } : null;
      } else ed.irPara(t);
    };
    const soltar = () => {
      window.removeEventListener('pointermove', mover);
      window.removeEventListener('pointerup', soltar);
      if (sel) this.render();
    };
    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', soltar);
  }

  arrastarClipe(e, id, tipo, no) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const ed = this.ed;
    ed.selecionar('clipe', id);
    const clip = LT.acharClipe(ed.tl, id);
    if (!clip) return;
    const lado = e.target.dataset?.lado || null;
    const m = ed.midia(clip.midia) || {};
    const x0 = e.clientX;
    const pts = this.pontosEncaixe(id);
    const guia = el('div', { class: 'guia-encaixe', style: { display: 'none' } });
    this.conteudo.append(guia);
    let movido = false;
    let novo = null;
    const espelhos = [...this.conteudo.querySelectorAll(`.clipe[data-id="${id}"]`)];
    const mover = (ev) => {
      const dx = ev.clientX - x0;
      if (!movido && Math.abs(dx) < 3) return;
      movido = true;
      const dt = dx / this.zoom;
      if (!lado) {
        let pos = Math.max(0, clip.pos + dt);
        const s1 = this.encaixar(pos, pts, null);
        const s2 = s1 === null ? this.encaixar(pos + LT.dur(clip), pts, null) : null;
        if (s1 !== null) pos = s1; else if (s2 !== null) pos = s2 - LT.dur(clip);
        const ponto = s1 ?? s2;
        guia.style.display = ponto === null ? 'none' : 'block';
        if (ponto !== null) guia.style.left = this.x(ponto) + 'px';
        novo = Math.max(0, pos);
        espelhos.forEach((n) => { n.style.left = this.x(novo) + 'px'; n.classList.add('arrastando'); });
      } else {
        let T = (lado === 'ini' ? clip.pos : LT.fimTl(clip)) + dt;
        const s = this.encaixar(T, pts, guia);
        if (s !== null) T = s;
        if (lado === 'ini') {
          T = Math.max(clip.pos - clip.ini, Math.min(T, LT.fimTl(clip) - 0.1));
          no.style.left = this.x(T) + 'px';
          no.style.width = this.x(LT.fimTl(clip) - T) + 'px';
        } else {
          T = Math.min(clip.pos + (m.duracao ?? Infinity) - clip.ini, Math.max(T, clip.pos + 0.1));
          no.style.width = this.x(T - clip.pos) + 'px';
        }
        novo = T;
      }
    };
    const soltar = () => {
      window.removeEventListener('pointermove', mover);
      window.removeEventListener('pointerup', soltar);
      guia.remove();
      if (!movido || novo === null) { ed.irPara(this.tDeEvento(e)); return; }
      if (!lado) ed.editar(tipo === 'N' ? 'Mover narração' : 'Mover take', (tl) => LT.moverClipe(tl, id, novo));
      else ed.editar('Aparar clipe', (tl) => LT.aparar(tl, id, lado, novo, m.duracao ?? Infinity));
    };
    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', soltar);
  }

  arrastarItem(e, id, tipo, no, pos, dur) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const ed = this.ed;
    ed.selecionar(tipo === 'T' ? 'texto' : 'legenda', id);
    const lado = e.target.dataset?.lado || null;
    const x0 = e.clientX;
    let movido = false;
    let dt = 0;
    const pts = this.pontosEncaixe(id);
    const mover = (ev) => {
      const dx = ev.clientX - x0;
      if (!movido && Math.abs(dx) < 3) return;
      movido = true;
      dt = dx / this.zoom;
      if (!lado) {
        let p = Math.max(0, pos + dt);
        const s = this.encaixar(p, pts, null);
        if (s !== null) p = s;
        dt = p - pos;
        no.style.left = this.x(p) + 'px';
      } else if (lado === 'ini') {
        dt = Math.min(dt, dur - 0.2);
        no.style.left = this.x(pos + dt) + 'px';
        no.style.width = this.x(dur - dt) + 'px';
      } else {
        dt = Math.max(dt, 0.2 - dur);
        no.style.width = this.x(dur + dt) + 'px';
      }
    };
    const soltar = () => {
      window.removeEventListener('pointermove', mover);
      window.removeEventListener('pointerup', soltar);
      if (!movido) { ed.irPara(this.tDeEvento(e)); return; }
      ed.editar(tipo === 'T' ? 'Ajustar texto' : 'Ajustar legenda', (tl) => {
        const item = (tipo === 'T' ? tl.textos : tl.legendas).find((x) => x.id === id);
        if (!item) return false;
        const chave = item.midia ? 't' : 'pos';
        if (!lado) item[chave] = Math.max(0, item[chave] + dt);
        else if (lado === 'ini') { item[chave] = Math.max(0, item[chave] + dt); item.dur = Math.max(0.2, item.dur - dt); }
        else item.dur = Math.max(0.2, item.dur + dt);
      });
    };
    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', soltar);
  }

  /** Aceita mídias arrastadas da aba Mídia. */
  prepararSoltar(faixa, idFaixa) {
    faixa.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('ugc/midia')) return;
      e.preventDefault();
      faixa.classList.add('sobre');
    });
    faixa.addEventListener('dragleave', () => faixa.classList.remove('sobre'));
    faixa.addEventListener('drop', (e) => {
      faixa.classList.remove('sobre');
      const mid = e.dataTransfer.getData('ugc/midia');
      if (!mid) return;
      e.preventDefault();
      let T = this.tDeEvento(e);
      const s = this.encaixar(T, this.pontosEncaixe(null), null);
      if (s !== null) T = s;
      const m = this.ed.midia(mid);
      if (!m) return;
      const destino = idFaixa === 'N' || m.tipo === 'audio' ? 'N' : 'V';
      this.ed.inserirMidia(mid, T, { faixa: destino });
    });
  }

  destruir() {}
}

