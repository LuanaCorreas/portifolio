"""MONTAR MEU VÍDEO — sugestão de sequência UGC.

Divide os takes analisados em blocos de fala, classifica cada bloco em uma das
6 etapas de um vídeo UGC e sugere a melhor ordem. Regras importantes:

* só usa trechos que EXISTEM no material gravado (nenhuma fala é inventada);
* cada sugestão mostra as palavras do próprio take que justificam a escolha;
* nada é aplicado sem aprovação: a interface pede para aprovar item por item.
"""
from __future__ import annotations

import time

from . import analise, projetos

ETAPAS = [
    ("gancho", "1. Gancho inicial", "Prende a atenção nos primeiros segundos."),
    ("apresentacao", "2. Apresentação do produto", "Mostra e nomeia o produto."),
    ("demonstracao", "3. Demonstração e textura", "Detalhes, textura, embalagem, close."),
    ("aplicacao", "4. Aplicação ou utilização", "Como você usa o produto."),
    ("beneficios", "5. Benefícios e experiência", "O que você sentiu / percebeu."),
    ("cta", "6. Encerramento e chamada para ação", "Convite para comprar, link, cupom."),
]

PALAVRAS = {
    "gancho": ["voce", "sabia", "segredo", "nunca", "pare", "para tudo", "olha isso", "descobri",
               "imagina", "se voce", "chega de", "cansad", "precisa", "ninguem", "verdade",
               "acredita", "melhor", "pior", "erro", "dica", "socorro", "gente", "atencao"],
    "apresentacao": ["esse e", "este e", "essa e", "esta e", "conhec", "apresent", "chegou",
                     "recebi", "o novo", "a nova", "lancamento", "produto", "marca", "comprei",
                     "ganhei", "testando", "testei", "kit", "linha"],
    "demonstracao": ["textura", "olha", "veja", "repara", "cremos", "leve", "levinho", "cheiro",
                     "cheirinho", "fragrancia", "perfume", "embalagem", "cor", "consistencia",
                     "gel", "espuma", "liquid", "oleo", "fluido", "gramas", "ml", "tamanho",
                     "pump", "tampa", "detalhe"],
    "aplicacao": ["aplic", "passo", "passar", "passei", "uso", "usar", "usando", "espalh",
                  "modo de usar", "primeiro", "depois", "em seguida", "massage", "coloco",
                  "pego", "quantidade", "rotina", "manha", "noite", "seca", "enxagu"],
    "beneficios": ["resultado", "sinto", "senti", "sentindo", "pele", "hidrat", "dura", "durou",
                   "amei", "adoro", "adorei", "gostei", "beneficio", "experiencia", "macia",
                   "maciez", "brilho", "absorve", "rapido", "diferenca", "melhorou", "recomendo",
                   "vale a pena", "incrivel", "perfeito", "apaixon", "favorito", "sem pesar"],
    "cta": ["link", "compre", "comprar", "garant", "aproveit", "corre", "cupom", "desconto",
            "bio", "clique", "clica", "carrinho", "site", "loja", "promocao", "frete",
            "segue", "salva", "comenta", "compartilh", "nao perde", "agora"],
}


def _termos_briefing(texto: str) -> list[str]:
    partes = [analise.normalizar(p) for p in (texto or "").replace(";", ",").replace("\n", ",").split(",")]
    return [p for p in partes if len(p) >= 3]


def _blocos_do_take(m: dict, detalhe: dict | None) -> list[dict]:
    dur = float(m.get("duracao") or 0)
    frases = (detalhe or {}).get("frases") or []
    mov = (detalhe or {}).get("movimento") or []
    if not frases:
        # take sem fala (ex.: close do produto) — bloco visual
        return [{"midia": m["id"], "ini": 0.0, "fim": dur, "texto": "", "visual": True,
                 "movimento": analise.movimento_em(mov, 0, dur) if mov else 0}]
    blocos, atual = [], [frases[0]]
    for f in frases[1:]:
        # nova "ideia" quando há pausa maior que 1 s e o bloco já tem conteúdo
        if f["ini"] - atual[-1]["fim"] > 1.0 and sum(x["fim"] - x["ini"] for x in atual) > 2.5:
            blocos.append(atual)
            atual = []
        atual.append(f)
    blocos.append(atual)
    saida = []
    for b in blocos:
        ini = max(0.0, b[0]["ini"] - 0.15)
        fim = min(dur, b[-1]["fim"] + 0.25)
        saida.append({"midia": m["id"], "ini": round(ini, 3), "fim": round(fim, 3),
                      "texto": " ".join(f["texto"] for f in b), "visual": False,
                      "movimento": analise.movimento_em(mov, ini, fim) if mov else 0})
    return saida


def _pontuar(bloco: dict, briefing: dict, ordem: float) -> dict:
    texto = " " + analise.normalizar(bloco["texto"]) + " "
    pont, evid = {}, {}
    for etapa, lista in PALAVRAS.items():
        achadas = [p for p in lista if f" {p}" in texto]
        pont[etapa] = float(len(achadas))
        evid[etapa] = achadas
    for termo in _termos_briefing(briefing.get("produto", "")) + _termos_briefing(briefing.get("marca", "")):
        if f" {termo}" in texto:
            pont["apresentacao"] += 2
            evid["apresentacao"].append(termo)
    for termo in _termos_briefing(briefing.get("beneficios", "")):
        palavras_chave = [w for w in termo.split() if len(w) > 3]
        if palavras_chave and any(f" {w[:6]}" in texto for w in palavras_chave):
            pont["beneficios"] += 2
            evid["beneficios"].append(termo)
    for termo in _termos_briefing(briefing.get("cta", "")):
        if any(f" {w[:6]}" in texto for w in termo.split() if len(w) > 3):
            pont["cta"] += 2
            evid["cta"].append(termo)
    if "?" in bloco["texto"]:
        pont["gancho"] += 1
        evid["gancho"].append("pergunta")
    if bloco["visual"]:
        forca = 2.0 if bloco["movimento"] > 0 else 1.0
        pont["demonstracao"] += forca
        evid["demonstracao"].append("imagem sem fala")
    # posição na gravação: começo tende a gancho, fim tende a CTA (peso pequeno)
    pont["gancho"] += 0.6 * (1 - ordem)
    pont["cta"] += 0.6 * ordem
    return {"pontos": pont, "evidencias": evid}


def montar(pid: str) -> dict:
    projeto = projetos.carregar(pid)
    briefing = projeto.get("briefing", {})
    takes = [m for m in projeto.get("midias", []) if m.get("tipo") == "video" and m.get("status") == "pronto"]
    if not takes:
        raise ValueError("Importe pelo menos um take de vídeo antes de montar.")
    sem_analise = [m["nome"] for m in takes if not m.get("analise")]

    blocos = []
    for m in takes:
        a = m.get("analise") or {}
        # takes alternativos (não são o melhor do grupo) entram com peso menor
        qualidade = (a.get("nota", 60) / 100) * (1.0 if a.get("melhor", True) else 0.75)
        for b in _blocos_do_take(m, analise.carregar_detalhe(pid, m["id"])):
            b["qualidade"] = qualidade
            b["take"] = m["nome"]
            b["melhor"] = a.get("melhor", True)
            b["grupo"] = a.get("grupo")
            blocos.append(b)
    total = max(1, len(blocos) - 1)
    for i, b in enumerate(blocos):
        b.update(_pontuar(b, briefing, i / total))
        b["id"] = projetos.novo_id("b")

    usados: set[str] = set()
    grupos_usados: set = set()
    etapas = []
    for chave, titulo, descricao in ETAPAS:
        limite = 1 if chave in ("gancho", "apresentacao", "cta") else 2
        candidatos = sorted(
            (b for b in blocos if b["id"] not in usados and b["pontos"][chave] >= 1
             and b["pontos"][chave] >= max(b["pontos"].values()) - 0.5),
            key=lambda b: (b["pontos"][chave] * (0.5 + b["qualidade"])), reverse=True)
        itens = []
        for b in candidatos:
            if len(itens) >= limite:
                break
            if not b["melhor"] and b["grupo"] in grupos_usados:
                continue
            usados.add(b["id"])
            if b["grupo"] is not None:
                grupos_usados.add(b["grupo"])
            itens.append(_item(b, chave))
        etapa = {"chave": chave, "titulo": titulo, "descricao": descricao, "itens": itens}
        if not itens:
            etapa["aviso"] = ("Não encontrei material gravado para esta etapa. Você pode escolher "
                              "um trecho manualmente ou gravar um novo take.")
        etapas.append(etapa)
    sobras = [_item(b, max(b["pontos"], key=b["pontos"].get)) for b in blocos if b["id"] not in usados]
    resultado = {"gerado": time.time(), "etapas": etapas, "sobras": sobras,
                 "sem_analise": sem_analise}
    projetos.alterar(pid, lambda p: p.__setitem__("montagem", resultado))
    return resultado


def _item(b: dict, etapa: str) -> dict:
    evid = b["evidencias"].get(etapa, [])
    if b["visual"]:
        motivo = "Trecho sem fala com imagem do produto (demonstração visual)."
    elif evid:
        motivo = "Palavras encontradas na sua fala: " + ", ".join(f"“{e}”" for e in evid[:5])
    else:
        motivo = "Posição na gravação."
    return {"id": b["id"], "midia": b["midia"], "take": b["take"], "ini": b["ini"],
            "fim": b["fim"], "texto": b["texto"], "motivo": motivo, "etapa": etapa,
            "nota": round(b["qualidade"] * 100), "status": "pendente"}
