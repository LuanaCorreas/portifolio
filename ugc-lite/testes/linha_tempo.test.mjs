// Testes do núcleo da timeline.  Rodar:  node --test testes/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as LT from '../web/js/linha_tempo.js';

const quase = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

function base() {
  // take A (0–4s) em 0, take B (0–5s) em 4; narração livre em 6; texto em 5
  return {
    clipes: [
      { id: 'a', faixa: 'V', midia: 'A', ini: 0, fim: 4, pos: 0, volume: 1 },
      { id: 'b', faixa: 'V', midia: 'B', ini: 0, fim: 5, pos: 4, volume: 1 },
      { id: 'n', faixa: 'N', midia: 'N1', ini: 0, fim: 3, pos: 6, volume: 1 },
    ],
    textos: [{ id: 't', texto: 'oi', pos: 5, dur: 1 }],
    legendas: [{ id: 'l', texto: 'fala do B', midia: 'B', t: 2, dur: 1 }],
  };
}

test('inserir no meio deslocando tudo mantém narração e texto sincronizados com o vídeo', () => {
  const tl = base();
  LT.inserirTake(tl, { midia: 'C', pedacos: [{ ini: 0, fim: 2 }] }, 4, 'tudo');
  quase(LT.acharClipe(tl, 'b').pos, 6, 'take B empurrado');
  quase(LT.acharClipe(tl, 'n').pos, 8, 'narração acompanhou');
  quase(tl.textos[0].pos, 7, 'texto acompanhou');
  quase(LT.resolverLegendas(tl)[0].ini, 8, 'legenda ancorada acompanhou o take B');
});

test('inserir deslocando só o vídeo deixa narração livre no lugar, mas vinculada acompanha', () => {
  const tl = base();
  tl.clipes.push({ id: 'n2', faixa: 'N', midia: 'N2', ini: 0, fim: 1, pos: 5, volume: 1 });
  assert.ok(LT.vincular(tl, 'n2', 5)); // 1s dentro do take B
  LT.inserirTake(tl, { midia: 'C', pedacos: [{ ini: 0, fim: 2 }] }, 4, 'video');
  quase(LT.acharClipe(tl, 'n').pos, 6, 'narração livre ficou no lugar');
  quase(LT.acharClipe(tl, 'n2').pos, 7, 'narração vinculada acompanhou o take');
  quase(tl.textos[0].pos, 5, 'texto ficou no lugar');
});

test('inserir no meio de um take divide o take', () => {
  const tl = base();
  LT.inserirTake(tl, { midia: 'C', pedacos: [{ ini: 0, fim: 1 }] }, 2, 'tudo');
  const v = LT.clipesFaixa(tl, 'V');
  assert.deepEqual(v.map((c) => [c.midia, c.ini, c.fim, c.pos]), [
    ['A', 0, 2, 0], ['C', 0, 1, 2], ['A', 2, 4, 3], ['B', 0, 5, 5],
  ]);
});

test('sobrescrever não desloca nada', () => {
  const tl = base();
  LT.inserirTake(tl, { midia: 'C', pedacos: [{ ini: 0, fim: 2 }] }, 3, 'nada');
  const v = LT.clipesFaixa(tl, 'V');
  assert.deepEqual(v.map((c) => [c.midia, c.ini, c.fim, c.pos]), [
    ['A', 0, 3, 0], ['C', 0, 2, 3], ['B', 1, 5, 5],
  ]);
  quase(LT.acharClipe(tl, 'n').pos, 6, 'narração intacta');
});

test('aprovar corte de origem remove o trecho e fecha o espaço', () => {
  const tl = base();
  const r = LT.removerIntervaloFonte(tl, 'B', 1, 2, 'tudo');
  quase(r, 1, 'removido');
  const v = LT.clipesFaixa(tl, 'V');
  assert.deepEqual(v.map((c) => [c.midia, c.ini, c.fim, c.pos]), [
    ['A', 0, 4, 0], ['B', 0, 1, 4], ['B', 2, 5, 5],
  ]);
  quase(LT.resolverLegendas(tl)[0].ini, 5, 'legenda (t=2) continua colada na fala');
});

test('pedaços sem cortes aprovados', () => {
  assert.deepEqual(LT.pedacosSemCortes(0, 10, [[2, 3], [5, 6]]),
    [{ ini: 0, fim: 2 }, { ini: 3, fim: 5 }, { ini: 6, fim: 10 }]);
});

test('excluir clipe fechando espaço e trocar ordem', () => {
  const tl = base();
  LT.excluirClipes(tl, ['a'], true, 'tudo');
  quase(LT.acharClipe(tl, 'b').pos, 0, 'B foi para o início');
  quase(LT.acharClipe(tl, 'n').pos, 2, 'narração acompanhou');
  const tl2 = base();
  LT.trocarOrdem(tl2, 'b', -1);
  quase(LT.acharClipe(tl2, 'b').pos, 0, 'B primeiro');
  quase(LT.acharClipe(tl2, 'a').pos, 5, 'A depois');
});

test('narração vinculada segue o take quando ele é reordenado; ajuste fino mantém vínculo', () => {
  const tl = base();
  LT.vincular(tl, 'n', 6); // t=2 do take B, desloc 0
  LT.trocarOrdem(tl, 'b', -1);
  quase(LT.acharClipe(tl, 'n').pos, 2, 'narração foi junto com B');
  LT.ajustarSinc(tl, 'n', 0.1);
  quase(LT.acharClipe(tl, 'n').vinculo.desloc, 0.1, 'deslocamento ajustado');
  LT.trocarOrdem(tl, 'b', 1);
  quase(LT.acharClipe(tl, 'n').pos, 6.1, 'mantém o ajuste após nova troca');
});

test('excluir trecho não corta narração vinculada', () => {
  const tl = base();
  LT.vincular(tl, 'n', 6);
  LT.excluirTrecho(tl, 6.5, 7, 'tudo');
  assert.equal(LT.clipesFaixa(tl, 'N').length, 1);
  quase(LT.acharClipe(tl, 'n').fim, 3, 'narração inteira');
});

test('cobertura: áudio sem vídeo e vídeo sem áudio', () => {
  const tl = base();
  tl.clipes.find((c) => c.id === 'n').pos = 8; // narração 8–11, vídeo termina em 9
  const cob = LT.cobertura(tl, { A: { tem_audio: false }, B: { tem_audio: true }, N1: { tem_audio: true } });
  assert.deepEqual(cob.videoSemAudio, [[0, 4]]);
  assert.deepEqual(cob.audioSemVideo, [[9, 11]]);
});

test('histórico desfaz e refaz', () => {
  const h = new LT.Historico({ timeline: base() });
  h.editar('mover', (e) => LT.moverClipe(e.timeline, 'n', 10));
  quase(LT.acharClipe(h.estado.timeline, 'n').pos, 10, 'movido');
  h.desfazer();
  quase(LT.acharClipe(h.estado.timeline, 'n').pos, 6, 'desfeito');
  h.refazer();
  quase(LT.acharClipe(h.estado.timeline, 'n').pos, 10, 'refeito');
  assert.equal(h.editar('nada', () => {}), false, 'sem mudança não entra no histórico');
});

test('mover take sobrescreve o que está por baixo', () => {
  const tl = base();
  LT.moverClipe(tl, 'a', 6);
  const v = LT.clipesFaixa(tl, 'V');
  assert.deepEqual(v.map((c) => [c.midia, c.ini, c.fim, c.pos]), [['B', 0, 2, 4], ['A', 0, 4, 6]]);
});
