// Campos do briefing do produto (usados no Novo projeto e no editor).
import { el, modal } from './ui.js';

export function camposBriefing(b = {}) {
  const campo = (id, rotulo, ajuda, multi = false) => el('div', { class: 'campo' },
    el('label', { for: id }, rotulo),
    multi ? el('textarea', { id, rows: 2 }, b[id.replace('b-', '')] || '') : el('input', { type: 'text', id, value: b[id.replace('b-', '')] || '' }),
    ajuda ? el('div', { class: 'ajuda' }, ajuda) : null);
  return el('div', {},
    el('div', { class: 'grade c2', style: { gap: '0 16px' } },
      campo('b-produto', 'Produto', 'Ex.: Sérum Vitamina C'), campo('b-marca', 'Marca', 'Ex.: Marca X')),
    campo('b-publico', 'Público', 'Para quem é o vídeo (opcional).'),
    campo('b-beneficios', 'Benefícios informados pela marca', 'Separe por vírgulas. A IA só usa benefícios que estejam aqui ou na sua fala.', true),
    campo('b-cta', 'Chamada para ação', 'Ex.: link na bio, cupom LUANA10.'),
    campo('b-observacoes', 'Observações', '', true));
}

export function lerBriefing(raiz) {
  const v = (id) => raiz.querySelector('#b-' + id)?.value.trim() || '';
  return { produto: v('produto'), marca: v('marca'), publico: v('publico'), beneficios: v('beneficios'), cta: v('cta'), observacoes: v('observacoes') };
}

export function editarBriefing(projeto, aoSalvar) {
  const corpo = camposBriefing(projeto.briefing || {});
  modal({
    titulo: 'Briefing do projeto', corpo,
    botoes: [{ texto: 'Cancelar' }, { texto: 'Salvar briefing', classe: 'primario', acao: () => aoSalvar(lerBriefing(corpo)) }],
  });
}

