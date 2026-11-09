"""Geração de legendas a partir da transcrição (com tempo de cada palavra).

Cada legenda fica "ancorada" no instante do arquivo de origem (``midia`` + ``t``).
Assim, quando um take é movido, cortado ou um novo take é inserido, a legenda
acompanha automaticamente a fala — áudio, imagem e legenda continuam sincronizados.
"""
from __future__ import annotations

import re

from . import analise, projetos


def gerar(pid: str, max_palavras: int = 5, max_dur: float = 2.8) -> list[dict]:
    projeto = projetos.carregar(pid)
    clipes = [c for c in projeto.get("timeline", {}).get("clipes", []) if c.get("midia")]
    usados: dict[str, list[tuple[float, float]]] = {}
    for c in clipes:
        usados.setdefault(c["midia"], []).append((float(c["ini"]), float(c["fim"])))
    itens = []
    for mid, faixas in usados.items():
        detalhe = analise.carregar_detalhe(pid, mid)
        if not detalhe:
            continue
        for frase in detalhe.get("frases", []):
            for bloco in _dividir(frase, max_palavras, max_dur):
                t, fim = bloco["ini"], bloco["fim"]
                if any(a - 0.05 <= t < b for a, b in faixas) or any(t < b and fim > a for a, b in faixas):
                    itens.append({"id": projetos.novo_id("l"), "texto": bloco["texto"], "midia": mid,
                                  "t": round(t, 3), "dur": round(max(0.6, fim - t), 3)})
    return itens


def _dividir(frase: dict, max_palavras: int, max_dur: float) -> list[dict]:
    palavras = frase.get("palavras") or []
    if not palavras:
        return [{"ini": frase["ini"], "fim": frase["fim"], "texto": frase["texto"]}]
    blocos, atual = [], []
    for w in palavras:
        if atual and (len(atual) >= max_palavras or w["fim"] - atual[0]["ini"] > max_dur
                      or w["ini"] - atual[-1]["fim"] > 0.5):
            blocos.append(atual)
            atual = []
        atual.append(w)
        if re.search(r"[.!?…]$", w["p"]):
            blocos.append(atual)
            atual = []
    if atual:
        blocos.append(atual)
    return [{"ini": b[0]["ini"], "fim": b[-1]["fim"], "texto": " ".join(w["p"] for w in b)}
            for b in blocos]
