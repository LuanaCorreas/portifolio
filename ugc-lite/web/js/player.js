// Pré-visualização em tempo real da timeline.
// Usa as versões leves (proxies) dos vídeos, um elemento <video> para a faixa de
// vídeo e um <audio> por clipe de narração. Um relógio próprio comanda tudo e
// corrige pequenas diferenças (sincronização) enquanto toca.
import * as LT from './linha_tempo.js';

const TOL_TOCANDO = 0.25;
const TOL_PARADO = 0.04;

export class Player {
  constructor(caixa, { obterEstado, urlProxy, aoTempo, aoFim }) {
    this.caixa = caixa;
    this.obterEstado = obterEstado;
    this.urlProxy = urlProxy;
    this.aoTempo = aoTempo;
    this.aoFim = aoFim;
    this.tempo = 0;
    this.tocando = false;
    this.ctx = null;
    this.ganhos = new WeakMap();
    this.audios = new Map(); // id do clipe -> <audio>
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.semVideo = document.createElement('div');
    this.semVideo.className = 'sem-video';
    this.camada = document.createElement('div');
    this.camada.className = 'camada-textos';
    caixa.append(this.video, this.semVideo, this.camada);
    this.srcAtual = '';
    this._loop = this._loop.bind(this);
    this.desenharSobreposicoes = () => {};
    this.atrasoSeek = 0;
  }

  // ---------------------------------------------------------------- áudio
  _garantirCtx() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _volume(elemento, valor) {
    // até 100% usa o volume do elemento; acima disso, um GainNode (volume até 200%)
    if (valor > 1 && this.ctx) {
      let g = this.ganhos.get(elemento);
      if (!g) {
        try {
          const src = this.ctx.createMediaElementSource(elemento);
          g = this.ctx.createGain();
          src.connect(g).connect(this.ctx.destination);
          this.ganhos.set(elemento, g);
        } catch { g = null; }
      }
      if (g) { g.gain.value = valor; elemento.volume = 1; return; }
    }
    const g = this.ganhos.get(elemento);
    if (g) g.gain.value = 1;
    elemento.volume = Math.max(0, Math.min(1, valor));
  }

  // ---------------------------------------------------------------- controle
  tocar() {
    const { timeline } = this.obterEstado();
    const total = LT.duracaoTotal(timeline);
    if (total <= 0) return;
    if (this.tempo >= total - 0.05) this.tempo = 0;
    this._garantirCtx();
    this.tocando = true;
    this.t0 = this.tempo;
    this.w0 = performance.now();
    requestAnimationFrame(this._loop);
  }

  pausar() {
    this.tocando = false;
    this.video.pause();
    for (const a of this.audios.values()) a.pause();
    this.sincronizar();
  }

  alternar() { this.tocando ? this.pausar() : this.tocar(); }

  irPara(t) {
    const { timeline } = this.obterEstado();
    this.tempo = Math.max(0, Math.min(t, Math.max(0, LT.duracaoTotal(timeline))));
    if (this.tocando) { this.t0 = this.tempo; this.w0 = performance.now(); }
    this.sincronizar();
    this.aoTempo && this.aoTempo(this.tempo);
  }

  _loop() {
    if (!this.tocando) return;
    const { timeline } = this.obterEstado();
    const total = LT.duracaoTotal(timeline);
    // Se o vídeo está carregando (após um corte), segura o relógio para não dessincronizar.
    if (this.esperandoVideo) {
      this.t0 = this.tempo;
      this.w0 = performance.now();
    } else {
      this.tempo = this.t0 + (performance.now() - this.w0) / 1000;
    }
    if (this.tempo >= total) {
      this.tempo = total;
      this.pausar();
      this.aoTempo && this.aoTempo(this.tempo);
      this.aoFim && this.aoFim();
      return;
    }
    this.sincronizar();
    this.aoTempo && this.aoTempo(this.tempo);
    requestAnimationFrame(this._loop);
  }

  // ---------------------------------------------------------------- sincronização
  sincronizar() {
    const { timeline, midias } = this.obterEstado();
    const T = this.tempo;
    const tol = this.tocando ? TOL_TOCANDO : TOL_PARADO;

    // vídeo
    const v = LT.clipeEm(timeline, 'V', T);
    this.esperandoVideo = false;
    if (v && midias[v.midia] && midias[v.midia].proxy) {
      const src = this.urlProxy(v.midia);
      const local = v.ini + (T - v.pos);
      this.semVideo.style.display = 'none';
      this.video.style.visibility = 'visible';
      if (this.srcAtual !== src) {
        this.srcAtual = src;
        this.video.src = src;
        this.video.currentTime = local;
      } else if (Math.abs(this.video.currentTime - local) > tol) {
        if (!this.video.seeking) this.video.currentTime = local;
      }
      const vol = v.mudo ? 0 : (v.volume ?? 1);
      this._volume(this.video, vol);
      this.video.muted = vol <= 0;
      if (this.tocando) {
        if (this.video.readyState < 3 || this.video.seeking) this.esperandoVideo = true;
        if (this.video.paused) this.video.play().catch(() => {});
      } else if (!this.video.paused) this.video.pause();
    } else {
      if (!this.video.paused) this.video.pause();
      this.video.style.visibility = 'hidden';
      this.semVideo.style.display = 'grid';
      this.semVideo.textContent = LT.duracaoTotal(timeline) > 0 ? '' : 'Arraste takes para a timeline ou use “Inserir” na aba Mídia.';
    }

    // narrações
    const ativos = new Set();
    for (const c of LT.clipesEm(timeline, 'N', T)) {
      const m = midias[c.midia];
      if (!m || !m.proxy) continue;
      ativos.add(c.id);
      let a = this.audios.get(c.id);
      const src = this.urlProxy(c.midia);
      if (!a) {
        a = new Audio();
        a.preload = 'auto';
        this.audios.set(c.id, a);
      }
      const local = c.ini + (T - c.pos);
      if (a.dataset.src !== src) { a.dataset.src = src; a.src = src; a.currentTime = local; }
      else if (Math.abs(a.currentTime - local) > tol && !a.seeking) a.currentTime = local;
      this._volume(a, c.mudo ? 0 : (c.volume ?? 1));
      if (this.tocando && a.paused && !this.esperandoVideo) a.play().catch(() => {});
      if ((!this.tocando || this.esperandoVideo) && !a.paused) a.pause();
    }
    for (const [id, a] of this.audios) {
      if (!ativos.has(id)) {
        if (!a.paused) a.pause();
        if (!LT.acharClipe(timeline, id)) { a.removeAttribute('src'); this.audios.delete(id); }
      }
    }
    this.desenharSobreposicoes(T);
  }

  destruir() {
    this.pausar();
    this.video.removeAttribute('src');
    for (const a of this.audios.values()) a.removeAttribute('src');
    this.audios.clear();
    if (this.ctx) this.ctx.close().catch(() => {});
  }
}
