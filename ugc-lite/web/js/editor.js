// Editor de vídeo: estado, salvamento automático, pré-visualização, inspetor,
// atalhos de teclado e exportação. A timeline visual está em timeline_ui.js e os
// painéis da esquerda (Mídia, Análise IA, Montar, Legendas, Textos) em paineis.js.
import * as LT from './linha_tempo.js';
import { MODOS } from './linha_tempo.js';
import { el, api, botao, aviso, modal, icone, escapar } from './ui.js';
import { aoMudarTarefa, verificarLogo, tarefasAtuais } from './tarefas.js';
import { Player } from './player.js';
import { editarBriefing } from './briefing.js';
import { TimelineUI } from './timeline_ui.js';
import { Paineis } from './paineis.js';

let atual = null;

export async function abrirEditor(raiz, pid, sistema) {
  fecharEditor();
  const projeto = await api('/api/projetos/' + pid);
  atual = new Editor(raiz, projeto, sistema);
  return atual;
}

export function fecharEditor() {
  if (atual) { atual.destruir(); atual = null; }
}


export class Editor {
  constructor(raiz, projeto, sistema) {
    this.raiz = raiz;
    this.p = projeto;
    this.pid = projeto.id;
    this.sis = sistema;
    this.cfg = sistema.config;
    const decisoes = {};
    for (const s of projeto.sugestoes || []) decisoes[s.id] = s.status;
    this.hist = new LT.Historico({ timeline: LT.normalizar(projeto.timeline), decisoes });
    LT.resolverVinculos(this.hist.estado.timeline);
    this.estilo = { ...(projeto.legenda_estilo || {}) };
    this.modo = projeto.editor?.modo_sinc || 'tudo';
    this.zoom = projeto.editor?.zoom || 60;
    this.selecao = null; // {tipo:'clipe'|'texto'|'legenda', id}
    this.trecho = null; // {a, b} seleção de intervalo na régua
    this.ondas = {};
    this.salvamento = { pendente: false, temporizador: null, emCurso: false };
    this.montarLayout();
    this.player = new Player(this.elPrevia, {
      obterEstado: () => ({ timeline: this.tl, midias: this.midias() }),
      urlProxy: (mid) => `/arquivo/${this.pid}/${mid}/proxy`,
      aoTempo: (t) => this.aoTempo(t),
      aoFim: () => this.atualizarBotaoPlay(),
    });
    this.player.desenharSobreposicoes = (t) => this.desenharSobreposicoes(t);
    this.timeline = new TimelineUI(this, this.elTl);
    this.paineis = new Paineis(this, this.elEsq);
    this.hist.aoMudar(() => this.aoEditar());
    this.desligarTarefas = aoMudarTarefa((t) => this.aoTarefa(t));
    this.intervalo = setInterval(() => this.paineis.atualizarProgresso(), 700);
    this.teclas = (e) => this.atalho(e);
    document.addEventListener('keydown', this.teclas);
    this.antesDeSair = () => this.salvarAgora(true);
    window.addEventListener('beforeunload', this.antesDeSair);
    this.renderTudo();
    if (sessionStorage.getItem('ugc:importar') === this.pid) {
      sessionStorage.removeItem('ugc:importar');
      setTimeout(() => this.paineis.escolherArquivos(), 250);
    }
  }

  get tl() { return this.hist.estado.timeline; }
  get decisoes() { return this.hist.estado.decisoes; }

  midias() { return Object.fromEntries(this.p.midias.map((m) => [m.id, m])); }
  midia(id) { return this.p.midias.find((m) => m.id === id); }
  estiloLegenda() {
    return { fonte: 'Arial', tamanho: 64, cor: '#FFFFFF', contorno: '#000000', espessura: 4, fundo: false, cor_fundo: '#000000', negrito: true, posicao: 'baixo', margem: 260, max_palavras: 5, ativar: true, ...this.estilo };
  }

  sugestoes() {
    return (this.p.sugestoes || []).map((s) => ({ ...s, status: this.decisoes[s.id] || s.status || 'pendente' }));
  }

  /** Cortes aprovados de um take (intervalos do arquivo de origem). */
  cortesAprovados(mid) {
    return this.sugestoes().filter((s) => s.midia === mid && s.acao === 'cortar' && s.status === 'aprovada').map((s) => [s.ini, s.fim]);
  }

  // ------------------------------------------------------------------ layout
  montarLayout() {
    this.raiz.innerHTML = '';
    const ed = el('div', { class: 'editor' });
    ed.style.setProperty('--altura-timeline', (Number(localStorage.getItem('ugc:alturaTl')) || 300) + 'px');
    document.body.style.setProperty('--altura-timeline', ed.style.getPropertyValue('--altura-timeline'));

    // barra superior
    this.elNome = el('input', { class: 'nome-projeto', value: this.p.nome, title: 'Clique para renomear', size: Math.max(10, this.p.nome.length) });
    this.elNome.addEventListener('change', () => { this.p.nome = this.elNome.value.trim() || this.p.nome; this.agendarSalvar(); });
    this.elSalvo = el('span', { class: 'estado-salvo' }, 'Tudo salvo');
    this.btDesfazer = botao('', () => this.desfazer(), { classe: 'icone fantasma', ic: 'desfazer', titulo: 'Desfazer (Ctrl+Z)' });
    this.btRefazer = botao('', () => this.refazer(), { classe: 'icone fantasma', ic: 'refazer', titulo: 'Refazer (Ctrl+Y)' });
    const topo = el('div', { class: 'ed-topo' },
      this.elNome, this.elSalvo, el('div', { class: 'cresce' }),
      this.btDesfazer, this.btRefazer,
      botao('Briefing', () => editarBriefing(this.p, (b) => { this.p.briefing = b; this.agendarSalvar(); aviso('Briefing atualizado.', 'ok'); }), { classe: 'peq fantasma', ic: 'editar' }),
      botao('Prévia rápida', () => this.exportar('previa'), { classe: 'peq', ic: 'olho', titulo: 'Exporta uma versão em 540×960 para conferir (mais rápido)' }),
      botao('EXPORTAR VÍDEO', () => this.exportar('final'), { classe: 'primario', ic: 'baixar' }));

    this.elEsq = el('aside', { class: 'ed-esq' });
    this.elDir = el('aside', { class: 'ed-dir insp' });
    this.elPrevia = el('div', { class: 'previa' + (this.cfg.export_enquadramento === 'ajustar' ? ' ajustar' : '') });
    this.elTempo = el('span', { class: 'tempo' }, '0:00.0 / 0:00.0');
    this.btPlay = el('button', { class: 'btn-play', title: 'Reproduzir / pausar (Espaço)', html: icone('play'), onclick: () => this.alternarPlay() });
    const centro = el('section', { class: 'ed-centro' },
      el('div', { class: 'previa-area' }, this.elPrevia),
      el('div', { class: 'controles' },
        botao('', () => this.irPara(0), { classe: 'icone fantasma', ic: 'inicio', titulo: 'Início (Home)' }),
        botao('', () => this.irPara(this.player.tempo - 1 / 30), { classe: 'icone fantasma', ic: 'esquerda', titulo: 'Quadro anterior (←)' }),
        this.btPlay,
        botao('', () => this.irPara(this.player.tempo + 1 / 30), { classe: 'icone fantasma', ic: 'direita', titulo: 'Próximo quadro (→)' }),
        botao('', () => this.irPara(LT.duracaoTotal(this.tl)), { classe: 'icone fantasma', ic: 'fim', titulo: 'Fim (End)' }),
        this.elTempo, el('div', { class: 'cresce' }),
        el('span', { class: 'fraco' }, 'Pré-visualização em tempo real (versão leve)')));
    const divisor = el('div', { class: 'ed-divisor', title: 'Arraste para redimensionar a timeline' });
    this.elTl = el('section', { class: 'ed-tl' });
    ed.append(topo, this.elEsq, centro, this.elDir, divisor, this.elTl);
    this.raiz.append(ed);
    this.elEditor = ed;

    divisor.addEventListener('pointerdown', (e) => {
      const y0 = e.clientY;
      const h0 = this.elTl.getBoundingClientRect().height;
      divisor.setPointerCapture(e.pointerId);
      const mover = (ev) => {
        const h = Math.max(170, Math.min(window.innerHeight - 260, h0 + (y0 - ev.clientY)));
        ed.style.setProperty('--altura-timeline', h + 'px');
        document.body.style.setProperty('--altura-timeline', h + 'px');
        localStorage.setItem('ugc:alturaTl', h);
      };
      divisor.addEventListener('pointermove', mover);
      divisor.addEventListener('pointerup', () => divisor.removeEventListener('pointermove', mover), { once: true });
    });
    this.elPrevia.addEventListener('click', (e) => { if (e.target === this.elPrevia || e.target.tagName === 'VIDEO') this.alternarPlay(); });
  }

  renderTudo() {
    this.timeline.render();
    this.paineis.render();
    this.renderInspetor();
    this.atualizarHistorico();
    this.player.sincronizar();
    this.aoTempo(this.player.tempo);
  }

  // ------------------------------------------------------------------ edição
  editar(descricao, funcao) {
    const ok = this.hist.editar(descricao, (estado) => {
      const r = funcao(estado.timeline, estado);
      LT.resolverVinculos(estado.timeline);
      return r;
    });
    return ok;
  }

  aoEditar() {
    if (this.selecao && !this.existeSelecao()) this.selecao = null;
    this.timeline.render();
    this.paineis.aoEditar();
    this.renderInspetor();
    this.atualizarHistorico();
    this.player.sincronizar();
    this.aoTempo(this.player.tempo);
    this.agendarSalvar();
  }

  existeSelecao() {
    const s = this.selecao;
    if (!s) return false;
    if (s.tipo === 'clipe') return !!LT.acharClipe(this.tl, s.id);
    if (s.tipo === 'texto') return this.tl.textos.some((t) => t.id === s.id);
    if (s.tipo === 'legenda') return this.tl.legendas.some((l) => l.id === s.id);
    return false;
  }

  selecionar(tipo, id) {
    this.selecao = tipo ? { tipo, id } : null;
    this.timeline.marcarSelecao();
    this.renderInspetor();
    this.player.sincronizar();
    if (tipo === 'legenda') this.paineis.focarLegenda(id);
  }

  desfazer() {
    const d = this.hist.desfazer();
    if (d) aviso('Desfeito: ' + d, 'info', 2000);
  }

  refazer() {
    const d = this.hist.refazer();
    if (d) aviso('Refeito: ' + d, 'info', 2000);
  }

  atualizarHistorico() {
    this.btDesfazer.disabled = !this.hist.podeDesfazer();
    this.btRefazer.disabled = !this.hist.podeRefazer();
    this.btDesfazer.title = this.hist.podeDesfazer() ? `Desfazer: ${this.hist.proximoDesfazer()} (Ctrl+Z)` : 'Nada para desfazer';
    this.btRefazer.title = this.hist.podeRefazer() ? `Refazer: ${this.hist.proximoRefazer()} (Ctrl+Y)` : 'Nada para refazer';
  }

  definirModo(modo) {
    this.modo = modo;
    this.agendarSalvar();
    this.timeline.render();
  }

  // ------------------------------------------------------------------ operações de alto nível
  inserirMidia(mid, T, { modo = this.modo, faixa = null, aplicarCortes = true, ini = null, fim = null, descricao = null } = {}) {
    const m = this.midia(mid);
    if (!m || m.status !== 'pronto') { aviso('Aguarde o arquivo terminar de ser preparado.', 'erro'); return; }
    faixa = faixa || (m.tipo === 'audio' ? 'N' : 'V');
    const a = ini ?? 0;
    const b = fim ?? m.duracao;
    const pedacos = aplicarCortes ? LT.pedacosSemCortes(a, b, this.cortesAprovados(mid)) : [{ ini: a, fim: b }];
    let ids = [];
    this.editar(descricao || `Inserir “${m.nome}”`, (tl) => { ids = LT.inserirTake(tl, { midia: mid, faixa, pedacos }, T, modo); });
    if (ids.length) this.selecionar('clipe', ids[0]);
    return ids;
  }

  dividirNoCursor() {
    const T = this.player.tempo;
    const sel = this.selecao?.tipo === 'clipe' ? [this.selecao.id] : null;
    const ok = this.editar('Dividir no cursor', (tl) => {
      const novos = LT.dividir(tl, T, ['V', 'N'], sel);
      return novos.length ? undefined : false;
    });
    if (!ok) aviso('Posicione o cursor sobre um clipe para dividir.', 'info', 2500);
  }

  excluirSelecao(fecharEspaco = false) {
    if (this.trecho) return this.excluirTrecho();
    const s = this.selecao;
    if (!s) return;
    if (s.tipo === 'clipe') this.editar(fecharEspaco ? 'Excluir e fechar espaço' : 'Excluir clipe', (tl) => LT.excluirClipes(tl, [s.id], fecharEspaco, this.modo));
    if (s.tipo === 'texto') this.editar('Excluir texto', (tl) => { tl.textos = tl.textos.filter((t) => t.id !== s.id); });
    if (s.tipo === 'legenda') this.editar('Excluir legenda', (tl) => { tl.legendas = tl.legendas.filter((l) => l.id !== s.id); });
    this.selecao = null;
    this.renderInspetor();
  }

  excluirTrecho() {
    if (!this.trecho) return;
    const { a, b } = this.trecho;
    this.editar(`Excluir trecho ${LT.formatarTempo(a, true)}–${LT.formatarTempo(b, true)}`, (tl) => { LT.excluirTrecho(tl, a, b, this.modo); });
    this.trecho = null;
    this.irPara(a);
    this.timeline.render();
  }

  adicionarTexto(texto = 'Seu texto aqui') {
    const id = LT.novoId('t');
    const T = this.player.tempo;
    this.editar('Adicionar texto', (tl) => {
      tl.textos.push({ id, texto, pos: T, dur: 3, estilo: { fonte: 'Arial', tamanho: 80, cor: '#FFFFFF', contorno: '#000000', espessura: 5, fundo: false, cor_fundo: '#000000', negrito: true, x: 0.5, y: 0.2 } });
    });
    this.selecionar('texto', id);
  }

  // ------------------------------------------------------------------ reprodução
  alternarPlay() { this.player.alternar(); this.atualizarBotaoPlay(); }
  atualizarBotaoPlay() { this.btPlay.innerHTML = icone(this.player.tocando ? 'pause' : 'play'); }
  irPara(t) { this.player.irPara(t); }

  aoTempo(t) {
    const total = LT.duracaoTotal(this.tl);
    this.elTempo.textContent = `${LT.formatarTempo(t, true)} / ${LT.formatarTempo(total, true)}`;
    this.timeline.moverCursor(t);
    this.paineis.aoTempo(t);
    if (!this.player.tocando) this.atualizarBotaoPlay();
  }

  /** Desenha textos e legendas sobre a pré-visualização (escala proporcional ao 1080×1920). */
  desenharSobreposicoes(T) {
    const textos = this.tl.textos.filter((t) => T >= t.pos && T < t.pos + t.dur);
    const leg = this.estiloLegenda();
    const legendas = leg.ativar ? LT.resolverLegendas(this.tl).filter((l) => T >= l.ini && T < l.fim) : [];
    const chave = JSON.stringify([textos, legendas.map((l) => l.id + l.texto), leg, this.selecao]);
    if (chave === this._chaveSobre) return;
    this._chaveSobre = chave;
    const camada = this.player.camada;
    camada.innerHTML = '';
    const cqw = (px) => `${(px / 1080) * 100}cqw`;
    const aplicarEstilo = (n, e) => {
      n.style.fontFamily = `"${e.fonte || 'Arial'}", Arial, sans-serif`;
      n.style.fontSize = cqw(e.tamanho || 64);
      n.style.fontWeight = e.negrito === false ? '400' : '700';
      n.style.color = e.cor || '#fff';
      if (e.fundo) {
        n.style.background = (e.cor_fundo || '#000000') + 'd0';
        n.style.webkitTextStroke = '0';
      } else {
        n.style.webkitTextStroke = `${cqw((e.espessura ?? 4) * 2)} ${e.contorno || '#000'}`;
      }
    };
    for (const l of legendas) {
      const n = el('div', { class: 'sobre-legenda' }, l.texto);
      aplicarEstilo(n, leg);
      const margem = `${((leg.margem ?? 260) / 1920) * 100}%`;
      if (leg.posicao === 'topo') n.style.top = margem;
      else if (leg.posicao === 'meio') { n.style.top = '50%'; n.style.transform = 'translate(-50%, -50%)'; }
      else n.style.bottom = margem;
      camada.append(n);
    }
    for (const t of textos) {
      const e = t.estilo || {};
      const n = el('div', { class: 'sobre-texto' + (this.selecao?.id === t.id ? ' selecionado' : '') }, t.texto);
      aplicarEstilo(n, { tamanho: 80, ...e });
      n.style.left = `${(e.x ?? 0.5) * 100}%`;
      n.style.top = `${(e.y ?? 0.2) * 100}%`;
      n.title = 'Arraste para posicionar';
      n.addEventListener('pointerdown', (ev) => this.arrastarTexto(ev, t.id, n));
      camada.append(n);
    }
  }

  arrastarTexto(ev, id, no) {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.selecao?.id !== id) this.selecionar('texto', id);
    const r = this.elPrevia.getBoundingClientRect();
    let x = null;
    let y = null;
    const mover = (e) => {
      x = Math.max(0.05, Math.min(0.95, (e.clientX - r.left) / r.width));
      y = Math.max(0.03, Math.min(0.97, (e.clientY - r.top) / r.height));
      no.style.left = x * 100 + '%';
      no.style.top = y * 100 + '%';
    };
    const soltar = () => {
      window.removeEventListener('pointermove', mover);
      window.removeEventListener('pointerup', soltar);
      if (x !== null) {
        this.editar('Posicionar texto', (tl) => {
          const t = tl.textos.find((z) => z.id === id);
          if (t) t.estilo = { ...(t.estilo || {}), x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
        });
      }
    };
    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', soltar);
  }

  // ------------------------------------------------------------------ inspetor (painel da direita)
  renderInspetor() {
    const d = this.elDir;
    d.innerHTML = '';
    const s = this.selecao;
    if (s?.tipo === 'clipe') {
      const c = LT.acharClipe(this.tl, s.id);
      if (c) return this.inspetorClipe(d, c);
    }
    if (s?.tipo === 'texto') {
      const t = this.tl.textos.find((x) => x.id === s.id);
      if (t) return this.inspetorTexto(d, t);
    }
    if (s?.tipo === 'legenda') {
      d.append(el('h3', {}, 'Legenda selecionada'), el('p', { class: 'fraco' }, 'Edite o texto e o tempo na aba Legendas, à esquerda.'));
      return;
    }
    const cob = LT.cobertura(this.tl, this.midias());
    const somaDur = (l) => l.reduce((x, [a, b]) => x + b - a, 0);
    d.append(...[
      el('h3', {}, 'Projeto'),
      el('p', { class: 'fraco' }, `${LT.clipesFaixa(this.tl, 'V').length} clipes de vídeo · ${LT.clipesFaixa(this.tl, 'N').length} narrações · ${this.tl.textos.length} textos · ${this.tl.legendas.length} legendas`),
      el('p', { class: 'fraco' }, `Duração total: ${LT.formatarTempo(LT.duracaoTotal(this.tl), true)}`),
      el('hr'),
      el('h3', {}, 'Sincronia'),
      cob.audioSemVideo.length ? el('p', {}, el('span', { class: 'selo erro' }, 'Áudio sem vídeo'), ` ${somaDur(cob.audioSemVideo).toFixed(1)}s (tela preta com som)`) : null,
      cob.videoSemAudio.length ? el('p', {}, el('span', { class: 'selo aviso' }, 'Vídeo sem áudio'), ` ${somaDur(cob.videoSemAudio).toFixed(1)}s`) : null,
      cob.lacunas.length ? el('p', {}, el('span', { class: 'selo' }, 'Espaços vazios'), ` ${cob.lacunas.length}`, ' ',
        botao('Fechar espaços', () => this.editar('Fechar espaços vazios', (tl) => LT.fecharLacunas(tl, this.modo)), { classe: 'peq' })) : null,
      !cob.audioSemVideo.length && !cob.videoSemAudio.length && !cob.lacunas.length ? el('p', { class: 'fraco' }, '✔ Nenhum problema de sincronia encontrado.') : null,
      el('div', { class: 'dica', html: `<b>Modo de sincronização:</b> ${escapar(MODOS[this.modo].nome)}<br>${escapar(MODOS[this.modo].desc)}` }),
      el('div', { class: 'dica', html: `<b>Atalhos</b><br><kbd>Espaço</kbd> reproduzir · <kbd>S</kbd> dividir · <kbd>Del</kbd> excluir · <kbd>Shift</kbd>+<kbd>Del</kbd> excluir e fechar espaço · <kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Y</kbd> desfazer/refazer · <kbd>←</kbd><kbd>→</kbd> quadro a quadro · <kbd>I</kbd>/<kbd>O</kbd> marcar trecho · <kbd>+</kbd>/<kbd>−</kbd> zoom · <kbd>Shift</kbd>+arrastar na régua: selecionar trecho` }),
    ].filter(Boolean));
  }

  campoNum(rotulo, valor, aoMudar, { passo = 0.1, min = 0, max = null, sufixo = 's' } = {}) {
    const i = el('input', { type: 'number', step: passo, min, max: max ?? undefined, value: Math.round(valor * 1000) / 1000 });
    i.addEventListener('change', () => { const v = parseFloat(i.value.replace(',', '.')); if (isFinite(v)) aoMudar(v); });
    return el('div', { class: 'campo' }, el('label', {}, `${rotulo}${sufixo ? ` (${sufixo})` : ''}`), i);
  }

  inspetorClipe(d, c) {
    const m = this.midia(c.midia) || { nome: '?', duracao: c.fim };
    const eNarr = c.faixa === 'N';
    const id = c.id;
    const ed = (desc, fn) => this.editar(desc, (tl) => { const x = LT.acharClipe(tl, id); if (x) return fn(x, tl); return false; });
    d.append(
      el('h3', {}, eNarr ? 'Narração / áudio' : 'Take de vídeo'),
      el('p', { class: 'fraco', style: { overflowWrap: 'anywhere' } }, m.nome),
      el('div', { class: 'grade-campos' },
        this.campoNum('Posição', c.pos, (v) => ed('Mover clipe', (x, tl) => LT.moverClipe(tl, id, v))),
        this.campoNum('Duração', LT.dur(c), (v) => ed('Ajustar duração', (x, tl) => LT.definirDuracao(tl, id, v, m.duracao, true, this.modo)), { min: 0.1 }),
        this.campoNum('Início no take', c.ini, (v) => ed('Ajustar início', (x) => { x.ini = Math.max(0, Math.min(v, x.fim - 0.1)); })),
        this.campoNum('Fim no take', c.fim, (v) => ed('Ajustar fim', (x) => { x.fim = Math.min(m.duracao, Math.max(v, x.ini + 0.1)); }))),
    );
    // volume
    const vol = el('input', { type: 'range', min: 0, max: 200, step: 5, value: Math.round((c.volume ?? 1) * 100) });
    const rot = el('span', { class: 'fraco' }, `${vol.value}%`);
    vol.addEventListener('input', () => { rot.textContent = vol.value + '%'; });
    vol.addEventListener('change', () => ed('Ajustar volume', (x) => { x.volume = vol.value / 100; }));
    const mudo = el('input', { type: 'checkbox', checked: !!c.mudo });
    mudo.addEventListener('change', () => ed(mudo.checked ? 'Silenciar' : 'Ativar som', (x) => { x.mudo = mudo.checked; }));
    d.append(el('div', { class: 'campo' }, el('div', { class: 'linha entre' }, el('label', { class: 'rotulo' }, eNarr ? 'Volume da narração' : 'Volume do áudio do take'), rot), vol),
      el('label', { class: 'check' }, mudo, 'Sem som (mudo)'));
    if (m.tipo === 'video' && !m.tem_audio) d.append(el('p', { class: 'fraco' }, 'Este take não tem áudio.'));

    d.append(el('hr'), el('div', { class: 'grupo-btn' },
      botao('Dividir no cursor', () => this.dividirNoCursor(), { classe: 'peq', ic: 'tesoura' }),
      !eNarr ? botao('', () => this.editar('Mover take para a esquerda', (tl) => LT.trocarOrdem(tl, id, -1)), { classe: 'peq icone', ic: 'esquerda', titulo: 'Trocar com o take anterior' }) : null,
      !eNarr ? botao('', () => this.editar('Mover take para a direita', (tl) => LT.trocarOrdem(tl, id, 1)), { classe: 'peq icone', ic: 'direita', titulo: 'Trocar com o próximo take' }) : null,
      botao('Excluir', () => this.excluirSelecao(false), { classe: 'peq perigo', ic: 'lixo' }),
      !eNarr ? botao('Excluir e fechar espaço', () => this.excluirSelecao(true), { classe: 'peq perigo' }) : null));

    if (eNarr) {
      d.append(el('hr'), el('h3', {}, 'Sincronização com o vídeo'));
      if (c.vinculo) {
        const mv = this.midia(c.vinculo.midia);
        d.append(el('p', {}, el('span', { class: 'selo ' + (c.vinculoPerdido ? 'erro' : 'ok') }, c.vinculoPerdido ? '⚠ ponto de sincronia cortado' : '🔗 Vinculada'),
          el('span', { class: 'fraco' }, ` ao take “${mv ? mv.nome : '?'}” em ${LT.formatarTempo(c.vinculo.t, true)}${c.vinculo.desloc ? ` (${c.vinculo.desloc > 0 ? '+' : ''}${c.vinculo.desloc.toFixed(2)}s)` : ''}`)));
        if (c.vinculoPerdido) d.append(el('p', { class: 'fraco' }, 'O trecho do vídeo onde ela estava presa foi removido. Ela ficou parada no lugar; vincule de novo num novo ponto.'));
      } else {
        d.append(el('p', { class: 'fraco' }, 'Livre: não acompanha os takes quando eles se movem (a não ser no modo “Deslocar tudo junto”).'));
      }
      d.append(el('div', { class: 'grupo-btn' },
        botao('Vincular ao vídeo no cursor', () => {
          const ok = this.editar('Vincular narração', (tl) => (LT.vincular(tl, id, this.player.tempo) ? undefined : false));
          if (!ok) aviso('Coloque o cursor sobre um take de vídeo para criar o ponto de sincronização.', 'info');
        }, { classe: 'peq', ic: 'link' }),
        c.vinculo ? botao('Desvincular', () => this.editar('Desvincular narração', (tl) => LT.desvincular(tl, id)), { classe: 'peq' }) : null));
      d.append(el('div', { class: 'rotulo', style: { margin: '12px 0 6px' } }, 'Ajuste fino'),
        el('div', { class: 'grupo-btn' },
          ...[[-0.5, '−0,5s'], [-0.1, '−0,1s'], [-1 / 30, '−1 quadro'], [1 / 30, '+1 quadro'], [0.1, '+0,1s'], [0.5, '+0,5s']].map(([v, t]) =>
            botao(t, () => this.editar('Ajuste fino da narração', (tl) => LT.ajustarSinc(tl, id, v)), { classe: 'peq' }))),
        el('div', { class: 'dica' }, 'Dica: coloque o cursor no momento da imagem que combina com o começo da fala, arraste a narração até ali e clique em “Vincular”. Depois disso, inserir ou mover takes não tira a narração do lugar certo.'));
    } else {
      const presas = this.tl.clipes.filter((x) => x.faixa === 'N' && x.vinculo && x.vinculo.midia === c.midia).length;
      if (presas) d.append(el('p', { class: 'fraco', style: { marginTop: '10px' } }, `🔗 ${presas} narração(ões) vinculada(s) a este take.`));
      const sug = this.sugestoes().filter((s) => s.midia === c.midia && s.status === 'pendente' && s.fim > c.ini && s.ini < c.fim);
      if (sug.length) d.append(el('div', { class: 'dica' }, `${sug.length} sugestão(ões) da IA para este trecho. Veja na aba “Análise IA”.`));
    }
  }

  inspetorTexto(d, t) {
    const id = t.id;
    const e = { tamanho: 80, fonte: 'Arial', cor: '#FFFFFF', contorno: '#000000', espessura: 5, fundo: false, cor_fundo: '#000000', negrito: true, x: 0.5, y: 0.2, ...(t.estilo || {}) };
    const ed = (desc, fn) => this.editar(desc, (tl) => { const x = tl.textos.find((z) => z.id === id); if (!x) return false; x.estilo = x.estilo || {}; fn(x); });
    const area = el('textarea', { rows: 3 }, t.texto);
    area.addEventListener('change', () => ed('Editar texto', (x) => { x.texto = area.value; }));
    d.append(el('h3', {}, 'Texto na tela'), el('div', { class: 'campo' }, el('label', {}, 'Texto'), area),
      el('div', { class: 'grade-campos' },
        this.campoNum('Início', t.pos, (v) => ed('Mover texto', (x) => { x.pos = Math.max(0, v); })),
        this.campoNum('Duração', t.dur, (v) => ed('Duração do texto', (x) => { x.dur = Math.max(0.2, v); }), { min: 0.2 })),
      this.controlesEstilo(e, (chave, valor) => ed('Estilo do texto', (x) => { x.estilo[chave] = valor; }), true),
      el('hr'), el('div', { class: 'grupo-btn' }, botao('Ir para o texto', () => this.irPara(t.pos + 0.01), { classe: 'peq' }), botao('Excluir texto', () => this.excluirSelecao(), { classe: 'peq perigo', ic: 'lixo' })),
      el('div', { class: 'dica' }, 'Arraste o texto na pré-visualização para posicioná-lo.'));
  }

  /** Controles de fonte/tamanho/cor/contorno/fundo/posição (textos e legendas). */
  controlesEstilo(e, mudar, ehTexto = false) {
    const fontes = ['Arial', 'Arial Black', 'Segoe UI', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Impact', 'Comic Sans MS', 'Calibri'];
    const fonte = el('select', {}, ...fontes.map((f) => el('option', { value: f, selected: f === e.fonte }, f)));
    fonte.addEventListener('change', () => mudar('fonte', fonte.value));
    const tam = el('input', { type: 'range', min: 24, max: 180, step: 2, value: e.tamanho });
    const tamRot = el('span', { class: 'fraco' }, `${e.tamanho}px`);
    tam.addEventListener('input', () => { tamRot.textContent = tam.value + 'px'; });
    tam.addEventListener('change', () => mudar('tamanho', Number(tam.value)));
    const cor = (chave) => { const i = el('input', { type: 'color', value: e[chave] || '#ffffff' }); i.addEventListener('change', () => mudar(chave, i.value.toUpperCase())); return i; };
    const chk = (chave, rot) => { const i = el('input', { type: 'checkbox', checked: !!e[chave] }); i.addEventListener('change', () => mudar(chave, i.checked)); return el('label', { class: 'check' }, i, rot); };
    const esp = el('input', { type: 'number', min: 0, max: 14, value: e.espessura ?? 4, style: { width: '64px' } });
    esp.addEventListener('change', () => mudar('espessura', Number(esp.value)));
    const caixa = el('div', {},
      el('div', { class: 'campo' }, el('label', {}, 'Fonte'), fonte),
      el('div', { class: 'campo' }, el('div', { class: 'linha entre' }, el('label', { class: 'rotulo' }, 'Tamanho'), tamRot), tam),
      el('div', { class: 'linha quebra', style: { marginBottom: '10px', gap: '12px' } },
        el('label', { class: 'check' }, cor('cor'), 'Cor'),
        el('label', { class: 'check' }, cor('contorno'), 'Contorno'), el('label', { class: 'check' }, esp, 'px')),
      el('div', { class: 'linha quebra', style: { marginBottom: '10px', gap: '12px' } }, chk('fundo', 'Caixa de fundo'), el('label', { class: 'check' }, cor('cor_fundo'), 'Cor da caixa'), chk('negrito', 'Negrito')));
    if (!ehTexto) {
      const pos = el('select', {}, ...[['baixo', 'Embaixo'], ['meio', 'No meio'], ['topo', 'No topo']].map(([v, t]) => el('option', { value: v, selected: v === e.posicao }, t)));
      pos.addEventListener('change', () => mudar('posicao', pos.value));
      const margem = el('input', { type: 'range', min: 40, max: 900, step: 10, value: e.margem ?? 260 });
      margem.addEventListener('change', () => mudar('margem', Number(margem.value)));
      caixa.append(el('div', { class: 'grade-campos' }, el('div', { class: 'campo' }, el('label', {}, 'Posição'), pos),
        el('div', { class: 'campo' }, el('label', {}, 'Distância da borda'), margem)));
    }
    return caixa;
  }

  // ------------------------------------------------------------------ teclado
  atalho(e) {
    const alvo = e.target;
    if (alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA' || alvo.tagName === 'SELECT' || alvo.isContentEditable)) return;
    if (document.querySelector('.modal-fundo')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    let feito = true;
    if (k === ' ') this.alternarPlay();
    else if (ctrl && (k === 'z' || k === 'Z') && !e.shiftKey) this.desfazer();
    else if (ctrl && (k === 'y' || k === 'Y' || ((k === 'z' || k === 'Z') && e.shiftKey))) this.refazer();
    else if (k === 's' || k === 'S') { if (ctrl) this.salvarAgora(); else this.dividirNoCursor(); }
    else if (k === 'Delete' || k === 'Backspace') this.excluirSelecao(e.shiftKey);
    else if (k === 'ArrowLeft') this.irPara(this.player.tempo - (e.shiftKey ? 1 : 1 / 30));
    else if (k === 'ArrowRight') this.irPara(this.player.tempo + (e.shiftKey ? 1 : 1 / 30));
    else if (k === 'Home') this.irPara(0);
    else if (k === 'End') this.irPara(LT.duracaoTotal(this.tl));
    else if (k === '+' || k === '=') this.timeline.definirZoom(this.zoom * 1.4);
    else if (k === '-' || k === '_') this.timeline.definirZoom(this.zoom / 1.4);
    else if (k === 'i' || k === 'I') this.timeline.marcarTrecho('a', this.player.tempo);
    else if (k === 'o' || k === 'O') this.timeline.marcarTrecho('b', this.player.tempo);
    else if (k === 'x' || k === 'X') this.excluirTrecho();
    else if (k === 'Escape') { this.trecho = null; this.selecionar(null); this.timeline.render(); }
    else feito = false;
    if (feito) e.preventDefault();
  }

  // ------------------------------------------------------------------ salvamento automático
  agendarSalvar() {
    this.salvamento.pendente = true;
    this.elSalvo.textContent = 'Alterações não salvas…';
    clearTimeout(this.salvamento.temporizador);
    this.salvamento.temporizador = setTimeout(() => this.salvarAgora(), 700);
  }

  dadosParaSalvar() {
    return {
      nome: this.p.nome,
      briefing: this.p.briefing,
      timeline: this.tl,
      legenda_estilo: this.estilo,
      montagem: this.p.montagem,
      sugestoes_estado: Object.entries(this.decisoes).map(([id, status]) => ({ id, status })),
      editor: { zoom: this.zoom, modo_sinc: this.modo },
    };
  }

  async salvarAgora(saindo = false) {
    if (!this.salvamento.pendente) return;
    clearTimeout(this.salvamento.temporizador);
    if (this.salvamento.emCurso && !saindo) { this.salvamento.temporizador = setTimeout(() => this.salvarAgora(), 400); return; }
    this.salvamento.emCurso = true;
    this.salvamento.pendente = false;
    if (!saindo) this.elSalvo.textContent = 'Salvando…';
    try {
      await api('/api/projetos/' + this.pid, { metodo: 'PUT', dados: this.dadosParaSalvar(), keepalive: saindo });
      if (!saindo) this.elSalvo.textContent = 'Salvo às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      this.salvamento.pendente = true;
      if (!saindo) {
        this.elSalvo.textContent = '⚠ Não foi possível salvar — tentando de novo…';
        this.salvamento.temporizador = setTimeout(() => this.salvarAgora(), 4000);
      }
    } finally {
      this.salvamento.emCurso = false;
    }
  }

  // ------------------------------------------------------------------ tarefas
  aoTarefa(t) {
    if (t.projeto !== this.pid) return;
    if (['concluida', 'erro', 'cancelada'].includes(t.estado)) this.recarregarProjeto();
    else this.paineis.atualizarProgresso();
  }

  async recarregarProjeto() {
    try {
      const novo = await api('/api/projetos/' + this.pid);
      this.p.midias = novo.midias;
      this.p.sugestoes = novo.sugestoes;
      this.p.exportacoes = novo.exportacoes;
      if (novo.montagem && (!this.p.montagem || novo.montagem.gerado > this.p.montagem.gerado)) this.p.montagem = novo.montagem;
      for (const s of novo.sugestoes) if (!(s.id in this.decisoes)) this.hist.estado.decisoes[s.id] = s.status;
      this.timeline.render();
      this.paineis.render();
      this.renderInspetor();
      this.player.sincronizar();
    } catch { /* tenta na próxima */ }
  }

  // ------------------------------------------------------------------ exportação
  exportar(tipo = 'final') {
    if (LT.duracaoTotal(this.tl) <= 0.05) { aviso('A timeline está vazia. Adicione takes antes de exportar.', 'erro'); return; }
    this.salvarAgora();
    const leg = el('input', { type: 'checkbox', checked: this.estiloLegenda().ativar !== false });
    let escolha = tipo;
    const opc = (v, titulo, desc) => {
      const r = el('input', { type: 'radio', name: 'tipo-exp', value: v, checked: v === escolha });
      const o = el('label', { class: 'opcao' + (v === escolha ? ' ativo' : '') }, r, el('div', {}, el('b', {}, titulo), el('span', {}, desc)));
      r.addEventListener('change', () => { escolha = v; o.parentElement.querySelectorAll('.opcao').forEach((x) => x.classList.toggle('ativo', x === o)); });
      return o;
    };
    const cfg = this.cfg;
    const cob = LT.cobertura(this.tl, this.midias());
    const corpo = el('div', {},
      opc('final', 'Vídeo final', `MP4 · H.264 · ${cfg.export_largura}×${cfg.export_altura} (9:16) · ${cfg.export_fps} fps · áudio AAC ${cfg.export_audio_kbps} kbps`),
      opc('previa', 'Prévia leve', `${cfg.previa_largura}×${cfg.previa_altura}, codificação rápida — para conferir antes do final e economizar processamento.`),
      el('label', { class: 'check', style: { margin: '8px 0' } }, leg, 'Gravar as legendas no vídeo'),
      el('p', { class: 'fraco' }, `Duração: ${LT.formatarTempo(LT.duracaoTotal(this.tl), true)}. Os cortes são feitos a partir dos arquivos originais, que continuam intactos. Também salvamos um arquivo .srt com as legendas.`),
      cob.audioSemVideo.length ? el('p', {}, el('span', { class: 'selo erro' }, 'Atenção'), ' Há trechos com áudio e tela preta (sem vídeo).') : null,
    );
    modal({
      titulo: 'Exportar vídeo', corpo,
      botoes: [{ texto: 'Cancelar' }, {
        texto: 'Começar exportação', classe: 'primario', acao: async () => {
          try {
            await this.salvarAgora();
            await api(`/api/projetos/${this.pid}/exportar`, { metodo: 'POST', dados: { tipo: escolha, legendas: leg.checked } });
            aviso('Exportação iniciada. Acompanhe o progresso no canto da tela.', 'info');
            verificarLogo();
            this.aguardarExportacao();
          } catch (e) { aviso(e.message, 'erro'); return false; }
        },
      }],
    });
  }

  aguardarExportacao() {
    const parar = aoMudarTarefa((t) => {
      if (t.projeto !== this.pid || t.tipo !== 'exportar') return;
      if (t.estado === 'concluida' && t.resultado) {
        parar();
        const r = t.resultado;
        const url = `/exportado/${this.pid}/${r.id}`;
        modal({
          titulo: r.tipo === 'previa' ? 'Prévia pronta!' : 'Vídeo exportado!',
          corpo: el('div', { class: 'export-cartao' }, el('video', { src: url, controls: true, autoplay: true }),
            el('div', {}, el('p', {}, r.nome), el('p', { class: 'fraco', style: { overflowWrap: 'anywhere' } }, r.arquivo),
              el('div', { class: 'grupo-btn' },
                el('a', { class: 'btn primario peq', href: url + '?baixar=1', html: icone('baixar') + '<span>Baixar</span>' }),
                botao('Abrir pasta', () => api('/api/abrir-pasta', { metodo: 'POST', dados: { projeto: this.pid, exportacao: r.id } }).catch((x) => aviso(x.message, 'erro')), { classe: 'peq', ic: 'pasta' }),
                botao('Ver exportações', () => { location.hash = '#/exportacoes'; }, { classe: 'peq' })))),
          botoes: [{ texto: 'Fechar' }],
        });
      } else if (['erro', 'cancelada'].includes(t.estado)) parar();
    });
  }

  destruir() {
    this.salvarAgora(true);
    clearInterval(this.intervalo);
    document.removeEventListener('keydown', this.teclas);
    window.removeEventListener('beforeunload', this.antesDeSair);
    this.desligarTarefas();
    this.player.destruir();
    this.timeline.destruir();
  }
}

export function tarefasDoProjeto(pid) { return tarefasAtuais().filter((t) => t.projeto === pid); }
