// Painel de tarefas em segundo plano (importação, análise, transcrição, exportação).
import { el, api, botao, aviso, escapar } from './ui.js';

const ouvintes = new Set();
const conhecidas = new Map(); // id -> estado
const dispensadas = new Set();
let lista = [];
let temporizador = null;

export function aoMudarTarefa(fn) { ouvintes.add(fn); return () => ouvintes.delete(fn); }
export function tarefasAtuais() { return lista; }
export function progressoDaMidia(mid) {
  return lista.find((t) => t.midia === mid && (t.estado === 'executando' || t.estado === 'na_fila')) || null;
}

export async function atualizarTarefas() {
  try {
    lista = await api('/api/tarefas');
  } catch {
    agendar(5000);
    return;
  }
  for (const t of lista) {
    const antes = conhecidas.get(t.id);
    if (antes !== t.estado) {
      conhecidas.set(t.id, t.estado);
      if (antes && ['concluida', 'erro', 'cancelada'].includes(t.estado)) {
        if (t.estado === 'erro') aviso(`${t.titulo}: ${t.erro}`, 'erro');
        if (t.estado === 'concluida' && t.tipo === 'exportar') aviso(t.mensagem || 'Exportação concluída!', 'ok', 7000);
      }
      for (const fn of ouvintes) fn(t, antes);
    }
  }
  desenhar();
  const ativa = lista.some((t) => t.estado === 'executando' || t.estado === 'na_fila');
  agendar(ativa ? 800 : 4000);
}

function agendar(ms) {
  clearTimeout(temporizador);
  temporizador = setTimeout(atualizarTarefas, ms);
}

export function verificarLogo() { agendar(150); }

function desenhar() {
  const caixa = document.getElementById('tarefas');
  caixa.innerHTML = '';
  const agora = Date.now() / 1000;
  const visiveis = lista.filter((t) => !dispensadas.has(t.id) && (
    t.estado === 'executando' || t.estado === 'na_fila' ||
    (t.estado === 'erro' && agora - (t.fim || agora) < 600) ||
    (t.estado === 'concluida' && t.tipo === 'exportar' && agora - (t.fim || agora) < 4)));
  const fila = visiveis.filter((t) => t.estado === 'na_fila');
  for (const t of visiveis.filter((x) => x.estado !== 'na_fila')) {
    const pct = Math.round((t.progresso || 0) * 100);
    const item = el('div', { class: 'tarefa ' + (t.estado === 'erro' ? 'erro' : '') });
    item.innerHTML = `<div class="linha entre"><div class="tit">${escapar(t.titulo)}</div><span class="fraco">${t.estado === 'executando' ? pct + '%' : ''}</span></div>
      <div class="msg">${escapar(t.estado === 'erro' ? t.erro : t.mensagem)}</div>`;
    if (t.estado === 'executando') {
      const barra = el('div', { class: 'barra' + (pct < 1 ? ' indeterminada' : '') }, el('i', { style: { width: pct + '%' } }));
      item.append(barra);
      const cancelar = botao('Cancelar', async () => { await api(`/api/tarefas/${t.id}/cancelar`, { metodo: 'POST' }); verificarLogo(); }, { classe: 'peq fantasma' });
      cancelar.style.marginTop = '6px';
      item.append(cancelar);
    } else if (t.estado === 'erro') {
      item.append(botao('Entendi', () => { dispensadas.add(t.id); desenhar(); }, { classe: 'peq' }));
    }
    caixa.append(item);
  }
  if (fila.length) {
    caixa.append(el('div', { class: 'tarefa' }, el('div', { class: 'msg', style: { margin: 0 } },
      `${fila.length} tarefa(s) aguardando na fila — processamos um arquivo por vez para não sobrecarregar o computador.`)));
  }
}
