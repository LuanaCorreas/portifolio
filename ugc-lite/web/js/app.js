// Meu Estúdio UGC Lite — navegação e páginas (Início, Novo projeto, Meus projetos,
// Exportações, Configurações). O Editor de vídeo fica em editor.js.
import { el, api, botao, aviso, confirmar, icone, escapar, tamanhoLegivel, dataLegivel, duracaoLegivel, modal } from './ui.js';
import { atualizarTarefas, aoMudarTarefa } from './tarefas.js';
import { abrirEditor, fecharEditor } from './editor.js';
import { camposBriefing, lerBriefing } from './briefing.js';

const conteudo = document.getElementById('conteudo');
let sistema = null;

async function carregarSistema(forcar = false) {
  if (!sistema || forcar) sistema = await api('/api/sistema');
  document.getElementById('versao').textContent = 'versão ' + sistema.versao;
  return sistema;
}

function pagina(...filhos) {
  conteudo.innerHTML = '';
  const p = el('div', { class: 'pagina' }, ...filhos);
  conteudo.append(p);
  return p;
}

function erroPagina(e) {
  pagina(el('div', { class: 'cartao vazio' }, el('h2', {}, 'Algo deu errado'), el('p', {}, e.message || String(e)),
    botao('Tentar novamente', () => rotear(), { classe: 'primario' })));
}

// ================================================================ rotas
async function rotear() {
  const [rota, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const nome = rota || 'inicio';
  document.querySelectorAll('.modal-fundo').forEach((m) => m.remove());
  document.querySelectorAll('#menu a.item').forEach((a) => a.classList.toggle('ativo', a.dataset.rota === nome));
  const noEditor = nome === 'editor';
  document.getElementById('app').classList.toggle('compacto', noEditor);
  document.body.classList.toggle('no-editor', noEditor);
  if (!noEditor) fecharEditor();
  try {
    if (nome === 'inicio') await paginaInicio();
    else if (nome === 'novo') await paginaNovo();
    else if (nome === 'projetos') await paginaProjetos();
    else if (nome === 'editor') await rotaEditor(arg);
    else if (nome === 'exportacoes') await paginaExportacoes();
    else if (nome === 'configuracoes') await paginaConfiguracoes();
    else location.hash = '#/inicio';
  } catch (e) {
    erroPagina(e);
  }
}

async function rotaEditor(pid) {
  if (!pid) {
    pid = localStorage.getItem('ugc:ultimo');
    if (pid) {
      try { await api('/api/projetos/' + pid); } catch { pid = null; }
    }
    if (!pid) {
      const lista = await api('/api/projetos');
      if (!lista.length) {
        aviso('Crie um projeto primeiro para começar a editar.');
        location.hash = '#/novo';
        return;
      }
      pid = lista[0].id;
    }
    history.replaceState(null, '', '#/editor/' + pid);
  }
  localStorage.setItem('ugc:ultimo', pid);
  conteudo.innerHTML = '';
  await abrirEditor(conteudo, pid, await carregarSistema());
}

// ================================================================ Início
async function paginaInicio() {
  const [sis, projetos] = await Promise.all([carregarSistema(true), api('/api/projetos')]);
  const d = sis.diagnostico;
  const hero = el('section', { class: 'hero' });
  hero.innerHTML = `<div>
      <span class="selo destaque">Edição de vídeos UGC no seu computador</span>
      <h1 style="margin-top:14px">Do take bruto ao vídeo <em>pronto para postar</em>.</h1>
      <p class="muted" style="max-width:52ch">Importe seus takes, deixe a IA sugerir cortes e a melhor sequência,
      aprove o que fizer sentido, ajuste na timeline e exporte em 1080×1920 — sem abrir o terminal.</p>
    </div>`;
  const acoes = el('div', { class: 'grupo-btn', style: { marginTop: '10px' } },
    botao('Novo projeto', () => (location.hash = '#/novo'), { classe: 'primario grande', ic: 'mais' }),
    projetos.length ? botao('Continuar editando', () => (location.hash = '#/editor/' + (localStorage.getItem('ugc:ultimo') || projetos[0].id)), { classe: 'grande', ic: 'video' }) : null);
  hero.firstElementChild.append(acoes);
  const passos = el('ol', { class: 'passos' });
  ['Crie um projeto e preencha o briefing do produto.', 'Importe todos os takes e narrações de uma vez.',
    'Clique em Analisar: transcrição, pausas, repetições e melhores takes.', 'Use MONTAR MEU VÍDEO e aprove as sugestões.',
    'Ajuste na timeline, revise as legendas e clique em EXPORTAR VÍDEO.'].forEach((t) => passos.append(el('li', {}, t)));
  hero.append(el('div', {}, el('h3', {}, 'Como funciona'), passos));

  const status = el('div', { class: 'cartao' }, el('h2', {}, 'Seu computador'));
  const item = (ok, titulo, texto, aviso2) => {
    const cor = ok ? 'var(--ok)' : aviso2 ? 'var(--ambar)' : 'var(--perigo)';
    return el('div', { class: 'status-item' }, el('span', { class: 'ponto', style: { background: cor } }),
      el('div', {}, el('b', {}, titulo), el('div', { class: 'fraco' }, texto)));
  };
  status.append(
    item(d.ffmpeg.ok, 'FFmpeg', d.ffmpeg.ok ? d.ffmpeg.versao : 'Não encontrado — necessário para importar e exportar. Configure o caminho em Configurações.'),
    item(d.whisper.ok, 'Faster-Whisper (transcrição)', d.whisper.ok ? `Versão ${d.whisper.versao} · modelo ${sis.config.whisper_modelo} · CPU ${sis.config.whisper_compute}` : d.whisper.erro, true),
    item(true, 'Python', `${d.python} · os dados ficam em ${sis.dados}`),
  );

  const recentes = el('div', { class: 'cartao' }, el('div', { class: 'linha entre' }, el('h2', {}, 'Projetos recentes'),
    botao('Ver todos', () => (location.hash = '#/projetos'), { classe: 'peq fantasma' })));
  if (!projetos.length) recentes.append(el('p', { class: 'muted' }, 'Nenhum projeto ainda. Que tal começar o primeiro?'));
  for (const p of projetos.slice(0, 4)) {
    recentes.append(el('div', { class: 'status-item', style: { cursor: 'pointer' }, onclick: () => (location.hash = '#/editor/' + p.id) },
      el('div', { class: 'cresce' }, el('b', {}, p.nome), el('div', { class: 'fraco' }, `${p.takes} takes · ${duracaoLegivel(p.duracao)} na timeline · editado ${dataLegivel(p.atualizado)}`))));
  }
  pagina(hero, el('div', { class: 'grade c2' }, recentes, status));
}

// ================================================================ Novo projeto
async function paginaNovo() {
  const nome = el('input', { type: 'text', id: 'nome', placeholder: 'Ex.: Sérum Glow — vídeo de rotina', autofocus: true });
  const briefing = camposBriefing();
  const criar = botao('Criar projeto e importar takes', async () => {
    criar.disabled = true;
    try {
      const p = await api('/api/projetos', { metodo: 'POST', dados: { nome: nome.value, briefing: lerBriefing(briefing) } });
      aviso('Projeto criado! Agora importe seus vídeos.', 'ok');
      sessionStorage.setItem('ugc:importar', p.id);
      location.hash = '#/editor/' + p.id;
    } catch (e) {
      aviso(e.message, 'erro');
      criar.disabled = false;
    }
  }, { classe: 'primario grande', ic: 'mais' });
  pagina(
    el('div', { class: 'cabecalho' }, el('div', {}, el('h1', {}, 'Novo projeto'), el('p', { class: 'muted' }, 'Cada vídeo fica num projeto, com seus takes, edições e exportações organizados.'))),
    el('div', { class: 'cartao', style: { maxWidth: '760px' } },
      el('div', { class: 'campo' }, el('label', { for: 'nome' }, 'Nome do projeto'), nome),
      el('h3', { style: { marginTop: '18px' } }, 'Briefing'),
      el('p', { class: 'fraco' }, 'Usado pelo MONTAR MEU VÍDEO para reconhecer o produto, benefícios e chamada para ação na sua fala. Nada é inventado: só sugerimos trechos que você realmente gravou.'),
      briefing, el('div', { class: 'linha', style: { marginTop: '8px' } }, criar)),
  );
  nome.focus();
}

// ================================================================ Meus projetos
async function paginaProjetos() {
  const lista = await api('/api/projetos');
  const grade = el('div', { class: 'grade c3' });
  for (const p of lista) {
    const capa = el('div', { class: 'projeto-capa', style: p.capa ? { backgroundImage: `url("${p.capa}")` } : {} });
    if (!p.capa) capa.innerHTML = icone('video');
    const card = el('div', { class: 'cartao projeto-cartao', onclick: () => (location.hash = '#/editor/' + p.id) }, capa,
      el('div', { class: 'projeto-info' }, el('h3', { title: p.nome }, p.nome),
        el('div', { class: 'fraco' }, `${p.takes} takes · ${p.audios} áudios · ${duracaoLegivel(p.duracao)}`),
        el('div', { class: 'fraco' }, 'Editado em ' + dataLegivel(p.atualizado)),
        el('div', { class: 'grupo-btn', style: { marginTop: '10px' }, onclick: (e) => e.stopPropagation() },
          botao('Abrir', () => (location.hash = '#/editor/' + p.id), { classe: 'peq primario' }),
          botao('Duplicar', async () => {
            try { await api(`/api/projetos/${p.id}/duplicar`, { metodo: 'POST' }); aviso('Projeto duplicado.', 'ok'); paginaProjetos(); } catch (e) { aviso(e.message, 'erro'); }
          }, { classe: 'peq' }),
          botao('Excluir', async () => {
            const ok = await confirmar('Excluir projeto?', `“${p.nome}” será removido junto com as cópias importadas, versões leves e exportações guardadas dentro do projeto. Os arquivos originais no seu computador (fora do projeto) não são tocados.`, { sim: 'Excluir projeto', perigo: true });
            if (!ok) return;
            try { await api('/api/projetos/' + p.id, { metodo: 'DELETE' }); aviso('Projeto excluído.'); paginaProjetos(); } catch (e) { aviso(e.message, 'erro'); }
          }, { classe: 'peq perigo' }))));
    grade.append(card);
  }
  pagina(
    el('div', { class: 'cabecalho' }, el('div', {}, el('h1', {}, 'Meus projetos'), el('p', { class: 'muted' }, `${lista.length} projeto(s)`)),
      botao('Novo projeto', () => (location.hash = '#/novo'), { classe: 'primario', ic: 'mais' })),
    lista.length ? grade : el('div', { class: 'cartao vazio', html: icone('pasta') + '<p>Você ainda não tem projetos.</p>' }),
  );
}

// ================================================================ Exportações
async function paginaExportacoes() {
  const lista = await api('/api/exportacoes');
  const caixa = el('div', { class: 'grade', style: { gap: '12px' } });
  for (const e of lista) {
    const url = `/exportado/${e.projeto}/${e.id}`;
    const card = el('div', { class: 'cartao export-cartao' },
      e.existe ? el('video', { src: url, controls: true, preload: 'metadata' }) : el('div', { class: 'vazio', style: { padding: '10px' } }, 'Arquivo não encontrado'),
      el('div', {},
        el('div', { class: 'linha entre quebra' }, el('h3', { style: { margin: 0 } }, e.nome),
          el('span', { class: 'selo ' + (e.tipo === 'previa' ? 'info' : 'ok') }, e.tipo === 'previa' ? 'Prévia' : 'Final')),
        el('p', { class: 'fraco', style: { marginTop: '4px' } },
          `Projeto: ${e.projeto_nome} · ${e.largura}×${e.altura} · ${e.fps} fps · ${duracaoLegivel(e.duracao)} · ${tamanhoLegivel(e.tamanho)} · ${dataLegivel(e.criado)}${e.legendas ? ' · com legendas' : ''}`),
        el('p', { class: 'fraco', style: { overflowWrap: 'anywhere' } }, e.arquivo),
        el('div', { class: 'grupo-btn' },
          e.existe ? el('a', { class: 'btn peq primario', href: url + '?baixar=1', html: icone('baixar') + '<span>Baixar</span>' }) : null,
          botao('Abrir pasta', () => api('/api/abrir-pasta', { metodo: 'POST', dados: { projeto: e.projeto, exportacao: e.id } }).catch((x) => aviso(x.message, 'erro')), { classe: 'peq', ic: 'pasta' }),
          botao('Abrir projeto', () => (location.hash = '#/editor/' + e.projeto), { classe: 'peq' }),
          botao('Remover', () => removerExportacao(e), { classe: 'peq perigo', ic: 'lixo' }))));
    caixa.append(card);
  }
  pagina(
    el('div', { class: 'cabecalho' }, el('div', {}, el('h1', {}, 'Exportações'), el('p', { class: 'muted' }, 'Todos os vídeos exportados, de todos os projetos.'))),
    lista.length ? caixa : el('div', { class: 'cartao vazio', html: icone('baixar') + '<p>Nenhum vídeo exportado ainda. No editor, use o botão <b>EXPORTAR VÍDEO</b>.</p>' }),
  );
}

function removerExportacao(e) {
  const apagar = el('input', { type: 'checkbox', id: 'apagar-arq' });
  modal({
    titulo: 'Remover exportação',
    corpo: el('div', {}, el('p', { class: 'muted' }, 'A exportação sairá da lista.'),
      el('label', { class: 'check' }, apagar, 'Também apagar o arquivo de vídeo exportado do disco')),
    botoes: [{ texto: 'Cancelar' }, {
      texto: 'Remover', classe: 'perigo', acao: async () => {
        try {
          await api(`/api/exportacoes/${e.projeto}/${e.id}${apagar.checked ? '?apagar_arquivo=1' : ''}`, { metodo: 'DELETE' });
          paginaExportacoes();
        } catch (x) { aviso(x.message, 'erro'); }
      },
    }],
  });
}

// ================================================================ Configurações
async function paginaConfiguracoes() {
  const sis = await carregarSistema(true);
  const c = sis.config;
  const campos = {};
  const campo = (chave, rotulo, tipo = 'text', ajuda = '', opcoes = null, extra = {}) => {
    let entrada;
    if (opcoes) {
      entrada = el('select', { id: 'cfg-' + chave }, ...opcoes.map(([v, t]) => el('option', { value: v, selected: String(c[chave]) === String(v) }, t)));
    } else if (tipo === 'checkbox') {
      entrada = el('input', { type: 'checkbox', id: 'cfg-' + chave, checked: !!c[chave] });
      campos[chave] = entrada;
      return el('div', { class: 'campo' }, el('label', { class: 'check' }, entrada, rotulo), ajuda ? el('div', { class: 'ajuda' }, ajuda) : null);
    } else {
      entrada = el('input', { type: tipo, id: 'cfg-' + chave, value: c[chave], ...extra });
    }
    campos[chave] = entrada;
    return el('div', { class: 'campo' }, el('label', { for: 'cfg-' + chave }, rotulo), entrada, ajuda ? el('div', { class: 'ajuda' }, ajuda) : null);
  };
  const d = sis.diagnostico;
  const salvar = botao('Salvar configurações', async () => {
    const dados = {};
    for (const [k, e] of Object.entries(campos)) dados[k] = e.type === 'checkbox' ? e.checked : e.value;
    try {
      await api('/api/config', { metodo: 'PUT', dados });
      await carregarSistema(true);
      aviso('Configurações salvas.', 'ok');
      paginaConfiguracoes();
    } catch (e) { aviso(e.message, 'erro'); }
  }, { classe: 'primario' });

  pagina(
    el('div', { class: 'cabecalho' }, el('div', {}, el('h1', {}, 'Configurações'), el('p', { class: 'muted' }, 'Ajustado para Windows 11, Intel Core i3 e 8 GB de RAM: processamento pela CPU, um vídeo por vez.')), salvar),
    el('div', { class: 'grade c2' },
      el('div', { class: 'cartao' }, el('h2', {}, 'Ferramentas'),
        el('p', { class: 'fraco' }, `FFmpeg: ${d.ffmpeg.ok ? '✔ ' + d.ffmpeg.caminho : '✖ não encontrado'}`),
        campo('ffmpeg', 'Caminho do ffmpeg.exe (opcional)', 'text', 'Deixe vazio para detectar automaticamente. Ex.: C:\\ffmpeg\\bin\\ffmpeg.exe'),
        campo('ffprobe', 'Caminho do ffprobe.exe (opcional)', 'text', 'Normalmente fica na mesma pasta do ffmpeg.exe.'),
        el('p', { class: 'fraco' }, `Faster-Whisper: ${d.whisper.ok ? '✔ versão ' + d.whisper.versao : '✖ ' + d.whisper.erro}`)),
      el('div', { class: 'cartao' }, el('h2', {}, 'Transcrição'),
        campo('whisper_modelo', 'Modelo Whisper', 'text', '', [['tiny', 'tiny (recomendado — leve e rápido)'], ['base', 'base (mais preciso, ~2× mais lento)']]),
        campo('whisper_pasta_modelo', 'Pasta local do modelo (opcional)', 'text', 'Se o modelo já está baixado numa pasta, informe aqui para funcionar sem internet.'),
        el('div', { class: 'grade', style: { gridTemplateColumns: '1fr 1fr', gap: '0 12px' } },
          campo('whisper_compute', 'Precisão', 'text', '', [['int8', 'int8 (recomendado)'], ['float32', 'float32']]),
          campo('whisper_threads', 'Núcleos da CPU', 'number', 'O i3-1115G4 tem 4.', null, { min: 1, max: 8 })),
        campo('whisper_vad', 'Ignorar trechos sem voz (VAD)', 'checkbox', 'Reduz erros de transcrição em silêncio.')),
      el('div', { class: 'cartao' }, el('h2', {}, 'Análise dos takes'),
        el('div', { class: 'grade', style: { gridTemplateColumns: '1fr 1fr', gap: '0 12px' } },
          campo('pausa_min', 'Pausa longa a partir de (s)', 'number', '', null, { step: 0.1, min: 0.3 }),
          campo('silencio_db', 'Limiar de silêncio (dB)', 'number', 'Mais negativo = mais rigoroso.', null, { step: 1 }),
          campo('sem_audio_db', 'Limiar "sem áudio" (dB)', 'number', '', null, { step: 1 }),
          campo('movimento_min', 'Movimento de demonstração', 'number', 'Abaixe se demonstrações não forem detectadas.', null, { step: 0.001, min: 0 })),
        campo('proxy_altura', 'Qualidade da versão leve para edição', 'number', '', [[480, 'Leve (480p) — mais fluido'], [640, 'Equilibrada (640p) — recomendado'], [854, 'Melhor (854p)']])),
      el('div', { class: 'cartao' }, el('h2', {}, 'Exportação'),
        el('p', { class: 'fraco' }, 'Padrão: MP4 · H.264 · 1080×1920 (9:16) · 30 fps · áudio AAC.'),
        campo('export_enquadramento', 'Vídeos horizontais', 'text', '', [['preencher', 'Preencher a tela (corta as laterais)'], ['ajustar', 'Mostrar inteiro (com faixas pretas)']]),
        el('div', { class: 'grade', style: { gridTemplateColumns: '1fr 1fr', gap: '0 12px' } },
          campo('export_preset', 'Velocidade', 'text', '', [['ultrafast', 'Máxima'], ['veryfast', 'Rápida (recomendado)'], ['faster', 'Média'], ['medium', 'Lenta (arquivo menor)']]),
          campo('export_crf', 'Qualidade (CRF)', 'number', '18 = altíssima, 23 = boa.', null, { min: 14, max: 30 }),
          campo('export_audio_kbps', 'Áudio (kbps)', 'number', '', [[128, '128'], [160, '160'], [192, '192'], [256, '256']]),
          campo('export_fps', 'Quadros por segundo', 'number', '', [[30, '30 fps'], [24, '24 fps'], [60, '60 fps']])),
        campo('export_pasta', 'Pasta para salvar os vídeos finais (opcional)', 'text', 'Vazio = dentro da pasta do projeto. Ex.: C:\\Users\\Voce\\Videos'),
        campo('export_quicksync', 'Usar Intel Quick Sync (experimental)', 'checkbox', 'Usa a Intel UHD Graphics para codificar. Se falhar, o app volta automaticamente para a CPU.'))),
  );
}

// ================================================================ início
window.addEventListener('hashchange', rotear);
aoMudarTarefa(() => {});
carregarSistema().catch(() => {});
atualizarTarefas();
rotear();
