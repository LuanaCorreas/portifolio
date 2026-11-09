// Painéis da esquerda do editor: Mídia, Análise IA, Montar meu vídeo, Legendas, Textos.
import * as LT from './linha_tempo.js';
import { MODOS } from './linha_tempo.js';
import { el, api, botao, aviso, confirmar, modal, icone, escapar, enviarArquivo, tamanhoLegivel, duracaoLegivel } from './ui.js';
import { progressoDaMidia, verificarLogo } from './tarefas.js';

const ABAS = [
  ['midia', 'Mídia'], ['analise', 'Análise IA'], ['montar', 'Montar vídeo'], ['legendas', 'Legendas'], ['textos', 'Textos'],
];

const TIPOS_SUG = {
  pausa: 'Pausa longa', repeticao: 'Repetição', erro: 'Erro / retomada', gaguejo: 'Palavra repetida', hesitacao: 'Hesitação',
  fala_confusa: 'Fala pouco clara', inicio_parado: 'Início parado', final_parado: 'Final parado', sem_audio: 'Sem áudio', demonstracao: 'Demonstração visual',
};

export class Paineis {
  constructor(ed, raiz) {
    this.ed = ed;
    this.raiz = raiz;
    this.aba = localStorage.getItem('ugc:aba') || 'midia';
    this.filtroSug = 'pendente';
    this.envios = new Map(); // nome -> progresso do envio
    this.abas = el('div', { class: 'abas', role: 'tablist' });
    this.corpo = el('div', { class: 'aba-corpo' });
    raiz.append(this.abas, this.corpo);
    this.inputArquivo = el('input', { type: 'file', multiple: true, accept: 'video/*,audio/*,.mov,.mkv,.m4a,.mts', style: { display: 'none' } });
    this.inputArquivo.addEventListener('change', () => { this.importar([...this.inputArquivo.files]); this.inputArquivo.value = ''; });
    raiz.append(this.inputArquivo);
  }

  get p() { return this.ed.p; }

  render() {
    this.abas.innerHTML = '';
    for (const [id, nome] of ABAS) {
      let rot = nome;
      if (id === 'analise') {
        const n = this.ed.sugestoes().filter((s) => s.status === 'pendente' && s.acao !== 'manter').length;
        if (n) rot += ` (${n})`;
      }
      this.abas.append(el('button', { class: this.aba === id ? 'ativo' : '', role: 'tab', onclick: () => { this.aba = id; localStorage.setItem('ugc:aba', id); this.render(); } }, rot));
    }
    const rolagem = this.corpo.scrollTop;
    this.corpo.innerHTML = '';
    ({ midia: () => this.abaMidia(), analise: () => this.abaAnalise(), montar: () => this.abaMontar(), legendas: () => this.abaLegendas(), textos: () => this.abaTextos() })[this.aba]();
    this.corpo.scrollTop = rolagem;
  }

  aoEditar() {
    this.render();
  }

  aoTempo(t) {
    if (this.aba !== 'legendas') return;
    const atuais = LT.resolverLegendas(this.ed.tl).filter((l) => t >= l.ini && t < l.fim).map((l) => l.id);
    this.corpo.querySelectorAll('.legenda-item').forEach((n) => n.classList.toggle('atual', atuais.includes(n.dataset.id)));
  }

  focarLegenda(id) {
    if (this.aba !== 'legendas') { this.aba = 'legendas'; this.render(); }
    const n = this.corpo.querySelector(`.legenda-item[data-id="${id}"] input`);
    if (n) { n.scrollIntoView({ block: 'center' }); n.focus(); }
  }

  atualizarProgresso() {
    this.corpo.querySelectorAll('[data-progresso-midia]').forEach((n) => {
      const t = progressoDaMidia(n.dataset.progressoMidia);
      const barra = n.querySelector('i');
      const msg = n.parentElement.querySelector('.msg-prog');
      if (t) {
        n.classList.toggle('indeterminada', t.estado === 'na_fila' || t.progresso < 0.01);
        barra.style.width = Math.round(t.progresso * 100) + '%';
        if (msg) msg.textContent = t.estado === 'na_fila' ? 'Na fila…' : t.mensagem;
      }
    });
  }

  // ================================================================== MÍDIA
  escolherArquivos() { this.inputArquivo.click(); }

  async importar(arquivos) {
    if (!arquivos.length) return;
    for (const a of arquivos) this.envios.set(a.name, 0);
    this.render();
    let ok = 0;
    for (const a of arquivos) {
      try {
        await enviarArquivo(this.ed.pid, a, (p) => { this.envios.set(a.name, p); this.atualizarEnvios(); });
        ok++;
      } catch (e) {
        aviso(e.message, 'erro');
      }
      this.envios.delete(a.name);
      await this.ed.recarregarProjeto();
      verificarLogo();
    }
    if (ok) aviso(`${ok} arquivo(s) importado(s). Preparando versões leves para edição…`, 'ok');
  }

  atualizarEnvios() {
    for (const [nome, p] of this.envios) {
      const n = this.corpo.querySelector(`[data-envio="${CSS.escape(nome)}"] i`);
      if (n) n.style.width = Math.round(p * 100) + '%';
    }
  }

  async usarSemCopiar() {
    if (this.ed.sis.seletor_nativo) {
      try {
        const r = await api('/api/selecionar-arquivos', { metodo: 'POST' });
        if (r.caminhos.length) return this.importarCaminhos(r.caminhos);
        return;
      } catch (e) { aviso(e.message, 'erro'); }
    }
    const area = el('textarea', { rows: 4, placeholder: 'C:\\Users\\Voce\\Videos\\take1.mp4' });
    modal({
      titulo: 'Usar arquivos sem copiar',
      corpo: el('div', {}, el('p', { class: 'muted' }, 'Cole o caminho completo de cada arquivo (um por linha). No Windows: segure Shift, clique com o botão direito no arquivo e escolha “Copiar como caminho”.'), area,
        el('p', { class: 'fraco' }, 'O arquivo continua onde está e é apenas lido. Se você movê-lo ou renomeá-lo, o projeto deixará de encontrá-lo.')),
      botoes: [{ texto: 'Cancelar' }, { texto: 'Adicionar', classe: 'primario', acao: () => this.importarCaminhos(area.value.split(/\r?\n/).filter((x) => x.trim())) }],
    });
  }

  async importarCaminhos(caminhos) {
    try {
      const r = await api(`/api/projetos/${this.ed.pid}/importar-caminhos`, { metodo: 'POST', dados: { caminhos } });
      for (const e of r.erros) aviso(e, 'erro');
      if (r.midias.length) aviso(`${r.midias.length} arquivo(s) adicionado(s) sem cópia.`, 'ok');
      await this.ed.recarregarProjeto();
      verificarLogo();
    } catch (e) { aviso(e.message, 'erro'); }
  }

  abaMidia() {
    const c = this.corpo;
    const soltar = el('div', { class: 'soltar' });
    soltar.innerHTML = `${icone('upload')}<div><b>Arraste vídeos e áudios aqui</b></div><div class="fraco">ou</div>`;
    soltar.append(el('div', { class: 'grupo-btn', style: { justifyContent: 'center', marginTop: '6px' } },
      botao('Importar do computador', () => this.escolherArquivos(), { classe: 'primario peq', ic: 'upload' }),
      botao('Usar sem copiar', () => this.usarSemCopiar(), { classe: 'peq', ic: 'pasta', titulo: 'Usa o arquivo no lugar onde ele está, sem fazer cópia (economiza espaço)' })),
    el('div', { class: 'fraco', style: { marginTop: '8px' } }, 'Seus arquivos originais nunca são alterados.'));
    soltar.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); soltar.classList.add('sobre'); } });
    soltar.addEventListener('dragleave', () => soltar.classList.remove('sobre'));
    soltar.addEventListener('drop', (e) => { e.preventDefault(); soltar.classList.remove('sobre'); this.importar([...e.dataTransfer.files]); });
    c.append(soltar);

    for (const [nome, p] of this.envios) {
      c.append(el('div', { class: 'midia', 'data-envio': nome, style: { display: 'block' } }, el('div', { class: 'nome' }, 'Enviando ' + nome),
        el('div', { class: 'barra', style: { marginTop: '6px' } }, el('i', { style: { width: Math.round(p * 100) + '%' } }))));
    }

    const videos = this.p.midias.filter((m) => m.tipo === 'video');
    const audios = this.p.midias.filter((m) => m.tipo === 'audio');
    const pendentesAnalise = videos.concat(audios).filter((m) => m.status === 'pronto' && !m.analisado);
    c.append(el('div', { class: 'secao-titulo' }, el('h3', {}, `Takes de vídeo (${videos.length})`),
      pendentesAnalise.length ? botao('Analisar todos', () => this.analisar(pendentesAnalise.map((m) => m.id)), { classe: 'peq', ic: 'ia' }) : null));
    if (!videos.length) c.append(el('p', { class: 'fraco' }, 'Nenhum take importado ainda.'));
    for (const m of videos) c.append(this.cartaoMidia(m));
    c.append(el('div', { class: 'secao-titulo', style: { marginTop: '16px' } }, el('h3', {}, `Áudios e narrações (${audios.length})`)));
    if (!audios.length) c.append(el('p', { class: 'fraco' }, 'Importe narrações gravadas separadamente (MP3, WAV, M4A…).'));
    for (const m of audios) c.append(this.cartaoMidia(m));
    this.atualizarProgresso();
  }

  cartaoMidia(m) {
    const pronto = m.status === 'pronto';
    const mini = el('div', { class: 'mini', title: pronto ? 'Reproduzir' : '' });
    if (m.miniatura) mini.style.backgroundImage = `url("/arquivo/${this.ed.pid}/${m.id}/miniatura")`;
    if (m.tipo === 'audio') mini.innerHTML = icone('audio', 'style="width:26px;height:26px;opacity:.7"');
    if (pronto) {
      mini.append(el('span', { class: 'play', html: icone('play') }), el('span', { class: 'dur' }, LT.formatarTempo(m.duracao)));
      mini.addEventListener('click', () => this.verMidia(m));
    }
    const a = m.analise;
    const meta = [];
    if (pronto) {
      if (m.tipo === 'video') meta.push(`${m.largura}×${m.altura} · ${m.orientacao} · ${m.fps} fps`);
      meta.push(`${(m.conteiner || '').toUpperCase()} · ${duracaoLegivel(m.duracao)} · ${tamanhoLegivel(m.tamanho)}`);
      if (m.tipo === 'video' && !m.tem_audio) meta.push('sem áudio');
    }
    const info = el('div', { style: { minWidth: 0 } }, el('div', { class: 'nome', title: m.nome }, m.nome),
      el('div', { class: 'meta' }, meta.join(' · ')));
    const selos = el('div', { class: 'linha quebra', style: { gap: '4px', marginTop: '4px' } });
    if (m.externo) selos.append(el('span', { class: 'selo info', title: m.arquivo }, 'sem cópia'));
    if (a) {
      selos.append(el('span', { class: 'selo ' + (a.nota >= 75 ? 'ok' : a.nota >= 55 ? 'aviso' : 'erro'), title: 'Nota de qualidade do take' }, `nota ${a.nota}`));
      if (m.tipo === 'video' && a.alternativas > 0) selos.append(el('span', { class: 'selo ' + (a.melhor ? 'destaque' : ''), title: `${a.alternativas + 1} takes parecidos (grupo ${a.grupo})` }, a.melhor ? '⭐ melhor take' : 'alternativo'));
    }
    if (selos.childElementCount) info.append(selos);
    if (m.status === 'processando' || progressoDaMidia(m.id)) {
      info.append(el('div', { class: 'meta msg-prog', style: { marginTop: '4px' } }, 'Preparando…'),
        el('div', { class: 'barra indeterminada', 'data-progresso-midia': m.id, style: { marginTop: '4px' } }, el('i', { style: { width: '0%' } })));
    } else if (m.status === 'erro') {
      info.append(el('div', { class: 'meta', style: { color: '#f39790' } }, m.erro || 'Erro ao preparar'),
        el('div', { class: 'acoes' }, botao('Tentar de novo', () => this.reprocessar(m), { classe: 'peq' }), botao('Remover', () => this.remover(m), { classe: 'peq perigo' })));
    }
    if (pronto && !progressoDaMidia(m.id)) {
      info.append(el('div', { class: 'acoes' },
        botao('Inserir', () => this.dialogoInserir(m), { classe: 'peq primario', ic: 'mais', titulo: 'Inserir na timeline' }),
        botao(m.analisado ? 'Reanalisar' : 'Analisar', () => this.analisar([m.id]), { classe: 'peq', ic: 'ia' }),
        botao('', () => this.remover(m), { classe: 'peq icone fantasma', ic: 'lixo', titulo: 'Remover do projeto' })));
    }
    const card = el('div', { class: 'midia ' + m.tipo + (pronto ? ' arrastavel' : ''), draggable: pronto ? 'true' : undefined, title: pronto ? 'Arraste para a timeline' : '' }, mini, info);
    card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('ugc/midia', m.id); e.dataTransfer.effectAllowed = 'copy'; });
    return card;
  }

  verMidia(m, ini = null, fim = null, titulo = null) {
    const video = el('video', { src: `/arquivo/${this.ed.pid}/${m.id}/proxy`, controls: true, autoplay: true, style: { width: '100%', maxHeight: '62vh', background: '#000', borderRadius: '8px' } });
    if (ini !== null) {
      video.addEventListener('loadedmetadata', () => { video.currentTime = Math.max(0, ini - 0.6); }, { once: true });
      video.addEventListener('timeupdate', () => { if (video.currentTime > fim + 0.6) video.pause(); });
    }
    const linhas = [
      ['Arquivo', m.nome], ['Duração', duracaoLegivel(m.duracao) + ` (${m.duracao}s)`],
      m.tipo === 'video' ? ['Resolução', `${m.largura}×${m.altura} (${m.orientacao})`] : null,
      m.tipo === 'video' ? ['Quadros por segundo', m.fps] : null,
      ['Formato', `${m.formato} (.${m.conteiner})`], ['Codec', [m.codec_video, m.codec_audio].filter(Boolean).join(' / ')],
      ['Áudio', m.tem_audio ? `${m.canais} canal(is), ${m.taxa_audio} Hz` : 'sem áudio'], ['Tamanho', tamanhoLegivel(m.tamanho)],
      ['Local', m.externo ? m.arquivo + ' (sem cópia)' : 'cópia dentro do projeto'],
    ].filter(Boolean);
    const tabela = el('table', { class: 'tabela' }, ...linhas.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', { style: { overflowWrap: 'anywhere' } }, String(v ?? '—')))));
    const corpo = el('div', { style: { display: 'grid', gridTemplateColumns: m.tipo === 'video' ? 'minmax(0,1fr) minmax(0,1fr)' : '1fr', gap: '16px' } }, video, ini === null ? tabela : el('div', {}, el('p', { class: 'muted' }, `Trecho ${LT.formatarTempo(ini, true)} – ${LT.formatarTempo(fim, true)} (tocando com 0,6s de margem).`)));
    const botoes = [{ texto: 'Fechar' }];
    if (m.analisado) botoes.unshift({ texto: 'Ver transcrição', acao: () => { this.verTranscricao(m); } });
    botoes.unshift({ texto: 'Inserir na timeline', classe: 'primario', acao: () => { this.dialogoInserir(m); } });
    modal({ titulo: titulo || m.nome, corpo, largo: true, botoes });
  }

  dialogoInserir(m, ini = null, fim = null) {
    const ed = this.ed;
    const T = ed.player.tempo;
    const total = LT.duracaoTotal(ed.tl);
    let onde = total > 0 ? 'fim' : 'inicio';
    let modo = ed.modo;
    const ehAudio = m.tipo === 'audio';
    let faixa = ehAudio ? 'N' : 'V';
    const grupo = (nome, opcoes, atual, aoMudar) => {
      const caixa = el('div', {});
      for (const [v, titulo, desc] of opcoes) {
        const r = el('input', { type: 'radio', name: nome, value: v, checked: v === atual });
        const o = el('label', { class: 'opcao' + (v === atual ? ' ativo' : '') }, r, el('div', {}, el('b', {}, titulo), desc ? el('span', {}, desc) : null));
        r.addEventListener('change', () => { aoMudar(v); caixa.querySelectorAll('.opcao').forEach((x) => x.classList.toggle('ativo', x === o)); });
        caixa.append(o);
      }
      return caixa;
    };
    const cortes = this.ed.cortesAprovados(m.id);
    const aplicar = el('input', { type: 'checkbox', checked: true });
    const corpo = el('div', {},
      !ehAudio ? el('div', {}, el('div', { class: 'rotulo', style: { marginBottom: '6px' } }, 'Em qual faixa?'),
        grupo('faixa', [['V', 'Vídeo (com o áudio do take)'], ['N', 'Só o áudio, como narração']], faixa, (v) => { faixa = v; })) : null,
      el('div', { class: 'rotulo', style: { margin: '10px 0 6px' } }, 'Onde inserir?'),
      grupo('onde', [['inicio', 'No início'], ['cursor', `No cursor (${LT.formatarTempo(T, true)})`, 'No meio do vídeo, onde está a linha laranja.'], ['fim', `No final (${LT.formatarTempo(total, true)})`]], onde, (v) => { onde = v; }),
      !ehAudio ? el('div', {}, el('div', { class: 'rotulo', style: { margin: '10px 0 6px' } }, 'O que acontece com o que vem depois?'),
        grupo('modo', Object.entries(MODOS).map(([v, x]) => [v, x.nome, x.desc]), modo, (v) => { modo = v; })) : el('p', { class: 'fraco' }, 'Narrações são colocadas sem empurrar nada (podem ficar por cima de outras).'),
      cortes.length ? el('label', { class: 'check', style: { marginTop: '10px' } }, aplicar, `Já aplicar os ${cortes.length} corte(s) aprovado(s) deste take`) : null);
    modal({
      titulo: `Inserir “${m.nome}”`, corpo,
      botoes: [{ texto: 'Cancelar' }, {
        texto: 'Inserir', classe: 'primario', acao: () => {
          const fimVideo = LT.clipesFaixa(ed.tl, 'V').reduce((x, c) => Math.max(x, LT.fimTl(c)), 0);
          const pos = onde === 'inicio' ? 0 : onde === 'cursor' ? T : fimVideo;
          ed.inserirMidia(m.id, pos, { modo, faixa, aplicarCortes: aplicar.checked, ini, fim });
          ed.irPara(pos);
        },
      }],
    });
  }

  async analisar(ids) {
    try {
      const r = await api(`/api/projetos/${this.ed.pid}/analisar`, { metodo: 'POST', dados: { midias: ids } });
      if (r.agendadas.length) aviso(`Análise iniciada para ${r.agendadas.length} arquivo(s). Um por vez, para não pesar no computador.`, 'info');
      else aviso('Esses arquivos já estão sendo analisados.', 'info');
      verificarLogo();
    } catch (e) { aviso(e.message, 'erro'); }
  }

  async reprocessar(m) {
    try { await api(`/api/projetos/${this.ed.pid}/midias/${m.id}/reprocessar`, { metodo: 'POST' }); verificarLogo(); this.ed.recarregarProjeto(); } catch (e) { aviso(e.message, 'erro'); }
  }

  async remover(m) {
    const ok = await confirmar('Remover do projeto?', m.externo
      ? `“${m.nome}” sai do projeto. O arquivo original continua no seu computador.`
      : `“${m.nome}” sai do projeto e a CÓPIA feita na importação é apagada. O arquivo original no seu computador não é tocado.`, { sim: 'Remover', perigo: true });
    if (!ok) return;
    try { await api(`/api/projetos/${this.ed.pid}/midias/${m.id}`, { metodo: 'DELETE' }); await this.ed.recarregarProjeto(); } catch (e) { aviso(e.message, 'erro'); }
  }

  async verTranscricao(m) {
    let d;
    try { d = await api(`/api/projetos/${this.ed.pid}/analise/${m.id}`); } catch (e) { aviso(e.message, 'erro'); return; }
    const corpo = el('div', {});
    if (!d.frases.length) corpo.append(el('p', { class: 'muted' }, 'Nenhuma fala transcrita neste arquivo.'));
    for (const f of d.frases) {
      corpo.append(el('div', { class: 'legenda-item', style: { gridTemplateColumns: '64px 1fr auto' } },
        el('span', { class: 't' }, LT.formatarTempo(f.ini, true)), el('span', {}, f.texto),
        botao('', () => this.verMidia(m, f.ini, f.fim, 'Trecho da fala'), { classe: 'peq icone fantasma', ic: 'play', titulo: 'Ouvir' })));
    }
    modal({ titulo: 'Transcrição — ' + m.nome, corpo, largo: true, botoes: [{ texto: 'Fechar' }] });
  }

  // ================================================================== ANÁLISE IA
  abaAnalise() {
    const c = this.corpo;
    const ed = this.ed;
    const diag = ed.sis.diagnostico;
    const midias = this.p.midias.filter((m) => m.status === 'pronto');
    const naoAnalisadas = midias.filter((m) => !m.analisado);
    c.append(el('p', { class: 'fraco' }, 'A IA transcreve suas falas e aponta pausas longas, repetições, erros, trechos sem áudio e demonstrações visuais. Nada é cortado sem a sua aprovação.'));
    if (!diag.whisper.ok) c.append(el('div', { class: 'dica', style: { borderLeft: '3px solid var(--ambar)' } }, diag.whisper.erro));
    c.append(el('div', { class: 'grupo-btn', style: { marginBottom: '12px' } },
      botao(naoAnalisadas.length ? `Analisar ${naoAnalisadas.length} arquivo(s)` : 'Reanalisar tudo', () => this.analisar((naoAnalisadas.length ? naoAnalisadas : midias).map((m) => m.id)), { classe: 'primario peq', ic: 'ia', desativado: !midias.length })));

    // resumo dos takes
    const analisados = midias.filter((m) => m.analise);
    if (analisados.length) {
      c.append(el('div', { class: 'secao-titulo' }, el('h3', {}, 'Takes')));
      for (const m of analisados.sort((a, b) => (a.analise.grupo || 0) - (b.analise.grupo || 0) || b.analise.nota - a.analise.nota)) {
        const a = m.analise;
        c.append(el('div', { class: 'sug ' + (a.melhor ? 'aprovada' : 'revisar'), style: { opacity: 1 } },
          el('div', { class: 'cab' }, el('b', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.nome),
            el('span', { class: 'selo ' + (a.nota >= 75 ? 'ok' : a.nota >= 55 ? 'aviso' : 'erro') }, `nota ${a.nota}`)),
          m.tipo === 'video' && a.alternativas > 0 ? el('div', { class: 'fraco' }, a.melhor ? `⭐ Melhor entre ${a.alternativas + 1} takes parecidos` : `Alternativo — existe um take parecido com nota maior`) : null,
          a.texto ? el('div', { class: 'trecho' }, '“' + (a.texto.length > 160 ? a.texto.slice(0, 160) + '…' : a.texto) + '”') : el('div', { class: 'fraco' }, a.aviso || 'Sem fala detectada.'),
          el('div', { class: 'fraco' }, `fala ${a.tempo_fala}s · ${a.pausas} pausas · ${a.repeticoes} repetições · ${a.erros} erros · ${a.demonstracoes} demonstrações`),
          el('div', { class: 'acoes' }, a.texto ? botao('Transcrição', () => this.verTranscricao(m), { classe: 'peq' }) : null)));
      }
    }

    // sugestões
    const todas = ed.sugestoes();
    const filtro = el('select', { style: { width: 'auto' } }, ...[['pendente', 'Pendentes'], ['todas', 'Todas'], ['aprovada', 'Aprovadas'], ['rejeitada', 'Recusadas']].map(([v, t]) => el('option', { value: v, selected: v === this.filtroSug }, t)));
    filtro.addEventListener('change', () => { this.filtroSug = filtro.value; this.render(); });
    c.append(el('div', { class: 'secao-titulo', style: { marginTop: '16px' } }, el('h3', {}, `Sugestões (${todas.filter((s) => s.status === 'pendente').length} pendentes)`), filtro));
    const altas = todas.filter((s) => s.status === 'pendente' && s.acao === 'cortar' && s.confianca === 'alta');
    if (altas.length) {
      c.append(botao(`Aprovar ${altas.length} corte(s) de alta confiança`, async () => {
        const ok = await confirmar('Aprovar vários cortes?', `${altas.length} trechos (pausas longas, inícios/finais parados e repetições claras) serão cortados dos takes que estão na timeline. Você pode desfazer com Ctrl+Z.`, { sim: 'Aprovar todos' });
        if (ok) this.decidir(altas, 'aprovada');
      }, { classe: 'peq ok', ic: 'check' }));
      c.lastChild.style.marginBottom = '10px';
    }
    const lista = todas.filter((s) => this.filtroSug === 'todas' || s.status === this.filtroSug);
    if (!lista.length) c.append(el('p', { class: 'fraco' }, todas.length ? 'Nenhuma sugestão neste filtro.' : 'Analise seus takes para receber sugestões.'));
    const nomes = Object.fromEntries(this.p.midias.map((m) => [m.id, m.nome]));
    let ultimo = null;
    for (const s of lista.sort((a, b) => (nomes[a.midia] || '').localeCompare(nomes[b.midia] || '') || a.ini - b.ini)) {
      if (s.midia !== ultimo) { c.append(el('div', { class: 'fraco', style: { margin: '10px 0 4px', fontWeight: 600 } }, nomes[s.midia] || '?')); ultimo = s.midia; }
      c.append(this.cartaoSugestao(s));
    }
  }

  cartaoSugestao(s) {
    const m = this.ed.midia(s.midia);
    const naTimeline = this.ed.tl.clipes.some((c) => c.faixa === 'V' && c.midia === s.midia && c.fim > s.ini && c.ini < s.fim);
    const classe = s.status !== 'pendente' ? s.status : s.acao === 'manter' ? 'manter' : s.acao === 'revisar' ? 'revisar' : '';
    const rotAprovar = s.acao === 'cortar' ? 'Cortar' : s.acao === 'manter' ? 'Preservar' : 'Revisado';
    return el('div', { class: 'sug ' + classe },
      el('div', { class: 'cab' }, el('b', {}, TIPOS_SUG[s.tipo] || s.tipo),
        el('span', { class: 'fraco' }, `${LT.formatarTempo(s.ini, true)}–${LT.formatarTempo(s.fim, true)} · ${(s.fim - s.ini).toFixed(1)}s`)),
      el('div', {}, s.motivo),
      s.trecho ? el('div', { class: 'trecho' }, '“' + s.trecho + '”') : null,
      el('div', { class: 'linha quebra', style: { gap: '4px' } },
        el('span', { class: 'selo ' + (s.confianca === 'alta' ? 'ok' : s.confianca === 'media' ? 'aviso' : '') }, 'confiança ' + s.confianca),
        s.acao === 'cortar' && !naTimeline && s.status === 'pendente' ? el('span', { class: 'selo info', title: 'Ao aprovar, o corte será aplicado quando você inserir este take' }, 'take fora da timeline') : null,
        s.status !== 'pendente' ? el('span', { class: 'selo ' + (s.status === 'aprovada' ? 'ok' : '') }, s.status === 'aprovada' ? 'aprovada' : 'recusada') : null),
      el('div', { class: 'acoes' },
        m ? botao('Ouvir', () => this.verMidia(m, s.ini, s.fim, TIPOS_SUG[s.tipo]), { classe: 'peq', ic: 'play' }) : null,
        s.status === 'pendente' ? botao(rotAprovar, () => this.decidir([s], 'aprovada'), { classe: 'peq ok', ic: 'check' }) : null,
        s.status === 'pendente' ? botao('Recusar', () => this.decidir([s], 'rejeitada'), { classe: 'peq', ic: 'x' }) : null,
        s.status !== 'pendente' ? botao('Voltar a pendente', () => {
          if (s.status === 'aprovada' && s.acao === 'cortar') aviso('Para recuperar o trecho cortado, use Desfazer (Ctrl+Z) ou ajuste a borda do clipe na timeline.', 'info', 7000);
          this.ed.editar('Voltar sugestão a pendente', (tl, est) => { est.decisoes[s.id] = 'pendente'; });
        }, { classe: 'peq fantasma' }) : null));
  }

  async decidir(lista, status) {
    const ed = this.ed;
    const preservadas = ed.sugestoes().filter((x) => x.acao === 'manter' && x.status !== 'rejeitada');
    if (status === 'aprovada') {
      const conflito = lista.find((s) => s.acao === 'cortar' && preservadas.some((p) => p.midia === s.midia && p.fim > s.ini && p.ini < s.fim));
      if (conflito) {
        const ok = await confirmar('Corte numa demonstração visual', 'Este corte atinge um trecho que parece ser uma demonstração visual importante (movimento sem fala). Cortar mesmo assim?', { sim: 'Cortar mesmo assim', perigo: true });
        if (!ok) return;
      }
    }
    let removido = 0;
    const desc = lista.length > 1 ? `Aprovar ${lista.length} sugestões` : `${status === 'aprovada' ? 'Aprovar' : 'Recusar'}: ${TIPOS_SUG[lista[0].tipo] || ''}`;
    ed.editar(desc, (tl, est) => {
      // do fim para o começo, para que um corte não mude a posição dos outros
      for (const s of [...lista].sort((a, b) => b.ini - a.ini)) {
        est.decisoes[s.id] = status;
        if (status === 'aprovada' && s.acao === 'cortar') removido += LT.removerIntervaloFonte(tl, s.midia, s.ini, s.fim, ed.modo);
      }
    });
    if (removido > 0.01) aviso(`Corte aplicado: ${removido.toFixed(1)}s removidos da timeline. Ctrl+Z desfaz.`, 'ok', 3500);
  }

  // ================================================================== MONTAR MEU VÍDEO
  abaMontar() {
    const c = this.corpo;
    const ed = this.ed;
    const mt = this.p.montagem;
    c.append(el('p', { class: 'fraco' }, 'A IA sugere a ordem dos seus takes em 6 etapas de um vídeo UGC, usando só o que você gravou e o briefing. Aprove cada item antes de aplicar.'));
    const montar = botao('MONTAR MEU VÍDEO', async () => {
      montar.disabled = true;
      try {
        const r = await api(`/api/projetos/${ed.pid}/montar`, { metodo: 'POST' });
        this.p.montagem = r;
        ed.agendarSalvar();
        this.render();
      } catch (e) { aviso(e.message, 'erro'); montar.disabled = false; }
    }, { classe: 'primario grande', ic: 'ia' });
    montar.style.width = '100%';
    c.append(montar);
    if (!mt) {
      const semAnalise = this.p.midias.filter((m) => m.tipo === 'video' && m.status === 'pronto' && !m.analisado).length;
      if (semAnalise) c.append(el('div', { class: 'dica' }, `Dica: analise os takes antes (aba Análise IA). Sem a transcrição, a montagem só consegue usar a ordem de gravação. ${semAnalise} take(s) sem análise.`));
      return;
    }
    if (mt.sem_analise?.length) c.append(el('div', { class: 'dica' }, `Takes sem análise (usados só pela posição): ${mt.sem_analise.join(', ')}`));
    const aprovados = mt.etapas.flatMap((e) => e.itens).filter((i) => i.status === 'aprovada');
    const mudar = () => { ed.agendarSalvar(); this.render(); };
    for (const etapa of mt.etapas) {
      const caixa = el('div', { class: 'etapa' }, el('h4', {}, etapa.titulo), el('div', { class: 'fraco' }, etapa.descricao));
      if (!etapa.itens.length) caixa.append(el('div', { class: 'fraco', style: { marginTop: '6px', color: 'var(--ambar)' } }, etapa.aviso || 'Sem material.'));
      etapa.itens.forEach((it, i) => {
        const m = ed.midia(it.midia);
        caixa.append(el('div', { class: 'item ' + it.status },
          el('div', { class: 'linha entre' }, el('b', { class: 'tit' }, (it.status === 'aprovada' ? '✔ ' : '') + it.take), el('span', { class: 'fraco' }, `${LT.formatarTempo(it.ini, true)}–${LT.formatarTempo(it.fim, true)}`)),
          it.texto ? el('div', { class: 'trecho', style: { fontStyle: 'italic', color: 'var(--texto-2)' } }, '“' + (it.texto.length > 140 ? it.texto.slice(0, 140) + '…' : it.texto) + '”') : null,
          el('div', { class: 'fraco' }, it.motivo),
          el('div', { class: 'acoes', style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '5px' } },
            m ? botao('', () => this.verMidia(m, it.ini, it.fim, etapa.titulo), { classe: 'peq icone', ic: 'play', titulo: 'Ouvir' }) : null,
            it.status !== 'aprovada' ? botao('Aprovar', () => { it.status = 'aprovada'; mudar(); }, { classe: 'peq ok', ic: 'check' }) : botao('Desaprovar', () => { it.status = 'pendente'; mudar(); }, { classe: 'peq' }),
            it.status !== 'rejeitada' ? botao('Recusar', () => { it.status = 'rejeitada'; mudar(); }, { classe: 'peq', ic: 'x' }) : null,
            i > 0 ? botao('', () => { etapa.itens.splice(i - 1, 0, etapa.itens.splice(i, 1)[0]); mudar(); }, { classe: 'peq icone fantasma', ic: 'esquerda', titulo: 'Subir na ordem' }) : null,
            i < etapa.itens.length - 1 ? botao('', () => { etapa.itens.splice(i + 1, 0, etapa.itens.splice(i, 1)[0]); mudar(); }, { classe: 'peq icone fantasma', ic: 'direita', titulo: 'Descer na ordem' }) : null,
            this.seletorEtapa(mt, it, etapa, mudar))));
      });
      c.append(caixa);
    }
    if (mt.sobras?.length) {
      const caixa = el('div', { class: 'etapa' }, el('h4', {}, 'Trechos não usados'), el('div', { class: 'fraco' }, 'Escolha uma etapa para incluir um trecho.'));
      for (const it of mt.sobras) {
        caixa.append(el('div', { class: 'item' }, el('div', { class: 'linha entre' }, el('b', {}, it.take), el('span', { class: 'fraco' }, `${LT.formatarTempo(it.ini, true)}–${LT.formatarTempo(it.fim, true)}`)),
          it.texto ? el('div', { class: 'fraco', style: { fontStyle: 'italic' } }, '“' + it.texto.slice(0, 120) + '”') : el('div', { class: 'fraco' }, it.motivo),
          el('div', { style: { marginTop: '5px' } }, this.seletorEtapa(mt, it, null, mudar))));
      }
      c.append(caixa);
    }
    const aplicar = botao(`Aplicar ${aprovados.length} item(ns) aprovado(s) à timeline`, () => this.aplicarMontagem(aprovados), { classe: 'primario', ic: 'check', desativado: !aprovados.length });
    aplicar.style.width = '100%';
    c.append(el('div', { style: { position: 'sticky', bottom: '-14px', background: 'var(--painel)', padding: '10px 0' } }, aplicar));
  }

  seletorEtapa(mt, it, etapaAtual, mudar) {
    const sel = el('select', { style: { width: 'auto', padding: '2px 6px', fontSize: '12px' }, title: 'Mover para outra etapa' },
      el('option', { value: '' }, etapaAtual ? 'Mover para…' : 'Incluir em…'),
      ...mt.etapas.filter((e) => e !== etapaAtual).map((e) => el('option', { value: e.chave }, e.titulo)));
    sel.addEventListener('change', () => {
      const destino = mt.etapas.find((e) => e.chave === sel.value);
      if (!destino) return;
      if (etapaAtual) etapaAtual.itens = etapaAtual.itens.filter((x) => x !== it);
      else mt.sobras = mt.sobras.filter((x) => x !== it);
      destino.itens.push({ ...it, etapa: destino.chave, status: etapaAtual ? it.status : 'pendente' });
      mudar();
    });
    return sel;
  }

  aplicarMontagem(itens) {
    const ed = this.ed;
    let substituir = LT.clipesFaixa(ed.tl, 'V').length === 0;
    const r1 = el('input', { type: 'radio', name: 'apl', checked: substituir });
    const r2 = el('input', { type: 'radio', name: 'apl', checked: !substituir });
    r1.addEventListener('change', () => { substituir = true; });
    r2.addEventListener('change', () => { substituir = false; });
    modal({
      titulo: 'Aplicar montagem',
      corpo: el('div', {},
        el('p', { class: 'muted' }, `${itens.length} trecho(s) aprovados serão colocados em sequência, já sem os cortes que você aprovou na Análise IA.`),
        el('label', { class: 'opcao' }, r1, el('div', {}, el('b', {}, 'Substituir os takes da timeline'), el('span', {}, 'Remove os clipes de vídeo atuais. Narrações e textos são mantidos.'))),
        el('label', { class: 'opcao' }, r2, el('div', {}, el('b', {}, 'Adicionar ao final'), el('span', {}, 'Mantém o que já está na timeline.')))),
      botoes: [{ texto: 'Cancelar' }, {
        texto: 'Aplicar', classe: 'primario', acao: () => {
          ed.editar('Aplicar MONTAR MEU VÍDEO', (tl) => {
            if (substituir) tl.clipes = tl.clipes.filter((c) => c.faixa !== 'V');
            let T = LT.clipesFaixa(tl, 'V').reduce((x, c) => Math.max(x, LT.fimTl(c)), 0);
            for (const it of itens) {
              const pedacos = LT.pedacosSemCortes(it.ini, it.fim, ed.cortesAprovados(it.midia));
              LT.inserirTake(tl, { midia: it.midia, pedacos }, T, 'nada');
              T += pedacos.reduce((s, p) => s + p.fim - p.ini, 0);
            }
          });
          ed.irPara(0);
          aviso('Montagem aplicada! Revise na timeline. Ctrl+Z desfaz.', 'ok');
        },
      }],
    });
  }

  // ================================================================== LEGENDAS
  abaLegendas() {
    const c = this.corpo;
    const ed = this.ed;
    const est = ed.estiloLegenda();
    const mudarEstilo = (chave, valor) => { ed.estilo = { ...ed.estilo, [chave]: valor }; ed._chaveSobre = null; ed.player.sincronizar(); ed.agendarSalvar(); };
    const ativar = el('input', { type: 'checkbox', checked: est.ativar !== false });
    ativar.addEventListener('change', () => mudarEstilo('ativar', ativar.checked));
    const maxp = el('input', { type: 'number', min: 1, max: 12, value: est.max_palavras || 5, style: { width: '64px' } });
    maxp.addEventListener('change', () => mudarEstilo('max_palavras', Number(maxp.value)));
    c.append(
      el('label', { class: 'check', style: { marginBottom: '10px' } }, ativar, 'Mostrar legendas no vídeo'),
      el('div', { class: 'linha quebra', style: { marginBottom: '10px' } },
        botao('Gerar legendas da transcrição', () => this.gerarLegendas(), { classe: 'primario peq', ic: 'ia' }),
        el('label', { class: 'check fraco' }, maxp, 'palavras por legenda')),
      el('p', { class: 'fraco' }, 'As legendas ficam presas à fala: se você mover ou cortar um take, elas acompanham.'),
    );
    const det = el('details', {}, el('summary', { style: { cursor: 'pointer', margin: '6px 0 10px', fontWeight: 600 } }, 'Estilo (fonte, tamanho, posição)'), ed.controlesEstilo(est, mudarEstilo));
    c.append(det);

    // localizar e substituir
    const de = el('input', { type: 'text', placeholder: 'Palavra errada' });
    const para = el('input', { type: 'text', placeholder: 'Correção' });
    c.append(el('div', { class: 'secao-titulo' }, el('h3', {}, 'Corrigir palavra em todas')),
      el('div', { class: 'linha' }, de, para, botao('Trocar', () => {
        const alvo = de.value.trim();
        if (!alvo) return;
        const re = new RegExp(alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        let n = 0;
        ed.editar(`Trocar “${alvo}”`, (tl) => { for (const l of tl.legendas) { const novo = l.texto.replace(re, () => { n++; return para.value; }); l.texto = novo; } });
        aviso(n ? `${n} ocorrência(s) corrigida(s).` : 'Palavra não encontrada.', n ? 'ok' : 'info');
      }, { classe: 'peq' })));

    const resolvidas = LT.resolverLegendas(ed.tl);
    const pos = Object.fromEntries(resolvidas.map((l) => [l.id, l]));
    const lista = [...ed.tl.legendas].sort((a, b) => (pos[a.id]?.ini ?? 1e9) - (pos[b.id]?.ini ?? 1e9));
    c.append(el('div', { class: 'secao-titulo', style: { marginTop: '14px' } }, el('h3', {}, `Legendas (${resolvidas.length})`),
      botao('Nova no cursor', () => {
        const id = LT.novoId('l');
        const T = ed.player.tempo;
        const v = LT.clipeEm(ed.tl, 'V', T) || LT.clipeEm(ed.tl, 'N', T);
        ed.editar('Nova legenda', (tl) => tl.legendas.push(v ? { id, texto: 'Nova legenda', midia: v.midia, t: v.ini + (T - v.pos), dur: 2 } : { id, texto: 'Nova legenda', pos: T, dur: 2 }));
        this.focarLegenda(id);
      }, { classe: 'peq', ic: 'mais' })));
    const ocultas = lista.filter((l) => !pos[l.id]).length;
    if (ocultas) c.append(el('p', { class: 'fraco' }, `${ocultas} legenda(s) de trechos que foram cortados não aparecem.`));
    for (const l of lista) {
      const r = pos[l.id];
      if (!r) continue;
      const entrada = el('input', { type: 'text', value: l.texto });
      entrada.addEventListener('change', () => ed.editar('Editar legenda', (tl) => { const x = tl.legendas.find((z) => z.id === l.id); if (x) x.texto = entrada.value; }));
      entrada.addEventListener('focus', () => { if (!ed.player.tocando) ed.irPara(r.ini + 0.01); });
      const ajustar = (d) => ed.editar('Ajustar tempo da legenda', (tl) => { const x = tl.legendas.find((z) => z.id === l.id); if (!x) return false; if (x.midia) x.t = Math.max(0, x.t + d); else x.pos = Math.max(0, x.pos + d); });
      const menu = el('div', { class: 'grupo-btn', style: { gap: '2px' } },
        botao('', () => ajustar(-0.1), { classe: 'peq icone fantasma', ic: 'esquerda', titulo: 'Adiantar 0,1s' }),
        botao('', () => ajustar(0.1), { classe: 'peq icone fantasma', ic: 'direita', titulo: 'Atrasar 0,1s' }),
        botao('', () => this.dividirLegenda(l.id), { classe: 'peq icone fantasma', ic: 'tesoura', titulo: 'Dividir em duas' }),
        botao('', () => ed.editar('Excluir legenda', (tl) => { tl.legendas = tl.legendas.filter((z) => z.id !== l.id); }), { classe: 'peq icone fantasma', ic: 'lixo', titulo: 'Excluir' }));
      c.append(el('div', { class: 'legenda-item', 'data-id': l.id },
        el('span', { class: 't', title: 'Ir para esta legenda', onclick: () => ed.irPara(r.ini + 0.01) }, LT.formatarTempo(r.ini, true)), entrada, menu));
    }
    if (!lista.length) c.append(el('p', { class: 'fraco' }, 'Nenhuma legenda. Analise os takes e clique em “Gerar legendas da transcrição”.'));
  }

  dividirLegenda(id) {
    this.ed.editar('Dividir legenda', (tl) => {
      const i = tl.legendas.findIndex((z) => z.id === id);
      if (i < 0) return false;
      const l = tl.legendas[i];
      const palavras = l.texto.split(/\s+/);
      if (palavras.length < 2) return false;
      const meio = Math.ceil(palavras.length / 2);
      const prop = meio / palavras.length;
      const d1 = l.dur * prop;
      const b = { ...l, id: LT.novoId('l'), texto: palavras.slice(meio).join(' '), dur: l.dur - d1 };
      if (l.midia) b.t = l.t + d1; else b.pos = l.pos + d1;
      l.texto = palavras.slice(0, meio).join(' ');
      l.dur = d1;
      tl.legendas.splice(i + 1, 0, b);
    });
  }

  async gerarLegendas() {
    const ed = this.ed;
    if (!ed.tl.clipes.length) { aviso('Coloque takes na timeline antes de gerar legendas.', 'info'); return; }
    if (ed.tl.legendas.length) {
      const ok = await confirmar('Gerar de novo?', 'As legendas atuais (incluindo correções feitas à mão) serão substituídas. Você pode desfazer com Ctrl+Z.', { sim: 'Substituir legendas' });
      if (!ok) return;
    }
    try {
      await ed.salvarAgora(); // o servidor lê a timeline salva
      const r = await api(`/api/projetos/${ed.pid}/legendas/gerar`, { metodo: 'POST', dados: { max_palavras: ed.estiloLegenda().max_palavras || 5 } });
      if (!r.legendas.length) { aviso('Nenhuma fala transcrita nos trechos da timeline. Analise os takes primeiro (aba Análise IA).', 'info', 6000); return; }
      ed.editar('Gerar legendas', (tl) => { tl.legendas = r.legendas; });
      aviso(`${r.legendas.length} legendas geradas. Revise as palavras na lista.`, 'ok');
    } catch (e) { aviso(e.message, 'erro'); }
  }

  // ================================================================== TEXTOS
  abaTextos() {
    const c = this.corpo;
    const ed = this.ed;
    c.append(el('p', { class: 'fraco' }, 'Textos aparecem por cima do vídeo (ex.: nome do produto, preço, “link na bio”). Arraste-os na pré-visualização para posicionar.'),
      botao('Adicionar texto no cursor', () => ed.adicionarTexto(), { classe: 'primario peq', ic: 'mais' }));
    const lista = [...ed.tl.textos].sort((a, b) => a.pos - b.pos);
    if (!lista.length) c.append(el('p', { class: 'fraco', style: { marginTop: '12px' } }, 'Nenhum texto ainda.'));
    for (const t of lista) {
      c.append(el('div', { class: 'sug revisar' + (ed.selecao?.id === t.id ? ' aprovada' : ''), style: { cursor: 'pointer', opacity: 1, marginTop: '8px' }, onclick: () => { ed.selecionar('texto', t.id); ed.irPara(t.pos + 0.01); } },
        el('div', { class: 'cab' }, el('b', {}, t.texto.split('\n')[0].slice(0, 40) || '(vazio)'), el('span', { class: 'fraco' }, `${LT.formatarTempo(t.pos, true)} · ${t.dur.toFixed(1)}s`))));
    }
  }
}
