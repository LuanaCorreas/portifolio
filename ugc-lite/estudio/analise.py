"""Análise inteligente dos takes.

Etapas (um take por vez):
 1. silêncios / pausas / trechos sem áudio (FFmpeg silencedetect);
 2. movimento na imagem (FFmpeg, detecção de mudança de cena) para reconhecer
    demonstrações visuais que devem ser preservadas mesmo sem fala;
 3. transcrição em português (Faster-Whisper tiny int8);
 4. heurísticas: repetições de frases, retomadas/erros de fala, gaguejos,
    hesitações, trechos com fala pouco clara;
 5. nota de qualidade de cada take e agrupamento de takes parecidos para
    indicar o melhor.

Nada é cortado automaticamente: tudo vira SUGESTÃO com status "pendente".
"""
from __future__ import annotations

import json
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

from . import config, projetos, transcricao
from .tarefas import ErroAmigavel, Tarefa, rodar_ffmpeg

# Expressões típicas de quando a gente erra e recomeça a frase
MARCADORES_ERRO = [
    "pera", "perai", "espera", "de novo", "comecar de novo", "vou de novo", "vou comecar",
    "errei", "desculpa", "desculpe", "opa", "corta", "nao nao", "deixa eu", "recomecar",
    "de novo de novo", "ai meu deus", "esqueci", "como e que", "como que e", "gravando",
    "ta gravando", "ja ta", "vamos la de novo", "mais uma vez",
]
HESITACOES = {"ah", "ahn", "aham", "eh", "ee", "eee", "hum", "hmm", "hm", "uhm", "um", "uh",
              "an", "ahh", "ehh", "humm", "ã", "ãh", "é..."}


def normalizar(texto: str) -> str:
    t = unicodedata.normalize("NFKD", texto.lower()).encode("ascii", "ignore").decode()
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


# ------------------------------------------------------------ medições FFmpeg

_RE_SIL_INI = re.compile(r"silence_start:\s*(-?[\d.]+)")
_RE_SIL_FIM = re.compile(r"silence_end:\s*([\d.]+)")


def detectar_silencios(origem: Path, limiar_db: float, minimo: float, duracao: float,
                       tarefa: Tarefa | None = None, faixa=(0, 1)) -> list[list[float]]:
    stderr = rodar_ffmpeg(
        ["-i", str(origem), "-vn", "-af", f"silencedetect=noise={limiar_db}dB:d={minimo}",
         "-f", "null", "-"], tarefa, duracao, faixa, "Procurando pausas e silêncios…")
    silencios, ini = [], None
    for linha in stderr.splitlines():
        m = _RE_SIL_INI.search(linha)
        if m:
            ini = max(0.0, float(m.group(1)))
            continue
        m = _RE_SIL_FIM.search(linha)
        if m and ini is not None:
            silencios.append([round(ini, 3), round(float(m.group(1)), 3)])
            ini = None
    if ini is not None:
        silencios.append([round(ini, 3), round(duracao, 3)])
    return silencios


_RE_PTS = re.compile(r"pts_time:([\d.]+)")
_RE_CENA = re.compile(r"lavfi\.scene_score=([\d.]+)")


def medir_movimento(video: Path, pasta: Path, duracao: float, tarefa: Tarefa | None = None,
                    faixa=(0, 1)) -> list[list[float]]:
    """Devolve [[tempo, intensidade]] com 4 amostras por segundo."""
    arq = "_movimento.txt"
    rodar_ffmpeg(["-i", str(video), "-an", "-vf",
                  f"fps=4,scale=64:-2,select='gte(scene\\,0)',metadata=print:file={arq}",
                  "-f", "null", "-"], tarefa, duracao, faixa, "Analisando movimento na imagem…",
                 cwd=str(pasta))
    caminho = pasta / arq
    amostras, t = [], None
    try:
        for linha in caminho.read_text(encoding="utf-8", errors="replace").splitlines():
            m = _RE_PTS.search(linha)
            if m:
                t = float(m.group(1))
                continue
            m = _RE_CENA.search(linha)
            if m and t is not None:
                amostras.append([round(t, 2), round(float(m.group(1)), 4)])
    finally:
        try:
            caminho.unlink()
        except OSError:
            pass
    return amostras


def movimento_em(movimento: list, a: float, b: float) -> float:
    vals = [v for t, v in movimento if a <= t <= b]
    if not vals:
        return 0.0
    vals.sort()
    # média do terço superior: uma demonstração tem picos de movimento
    topo = vals[len(vals) * 2 // 3:] or vals
    return sum(topo) / len(topo)


# ------------------------------------------------------------ heurísticas de fala

def montar_frases(segmentos: list[dict], pausa=0.45) -> list[dict]:
    """Divide a transcrição em frases curtas usando pausas e pontuação."""
    frases, atual = [], []
    palavras = [w for s in segmentos for w in s.get("palavras", [])]
    if not palavras:  # transcrição sem tempos por palavra
        return [{"ini": s["ini"], "fim": s["fim"], "texto": s["texto"], "palavras": []}
                for s in segmentos if s.get("texto")]
    for w in palavras:
        if atual and (w["ini"] - atual[-1]["fim"] > pausa or re.search(r"[.!?…]$", atual[-1]["p"])):
            frases.append(atual)
            atual = []
        atual.append(w)
    if atual:
        frases.append(atual)
    return [{"ini": f[0]["ini"], "fim": f[-1]["fim"], "texto": " ".join(w["p"] for w in f),
             "palavras": f} for f in frases]


def _sug(midia: str, tipo: str, ini: float, fim: float, motivo: str, *, acao="cortar",
         confianca="media", trecho: str = "") -> dict:
    return {"id": projetos.novo_id("s"), "midia": midia, "tipo": tipo,
            "ini": round(max(0.0, ini), 3), "fim": round(fim, 3), "motivo": motivo,
            "acao": acao, "confianca": confianca, "trecho": trecho.strip()[:200],
            "status": "pendente"}


def sugestoes_de_fala(mid: str, frases: list[dict]) -> list[dict]:
    sugs = []
    norm = [normalizar(f["texto"]).split() for f in frases]
    usados = set()
    # 1) Repetições: uma frase recomeçada logo depois -> sugerir remover a tentativa anterior
    for i, fi in enumerate(frases):
        if not norm[i] or i in usados:
            continue
        for j in range(i + 1, min(len(frases), i + 4)):
            if not norm[j] or frases[j]["ini"] - fi["fim"] > 8:
                break
            sim = SequenceMatcher(None, norm[i], norm[j]).ratio()
            k = min(3, len(norm[i]), len(norm[j]))
            recomeco = k >= 2 and norm[i][:k] == norm[j][:k]
            if sim >= 0.6 or recomeco:
                fim = frases[j]["ini"] - 0.08
                if fim - fi["ini"] < 0.3:
                    continue
                sugs.append(_sug(
                    mid, "repeticao", fi["ini"] - 0.05, fim,
                    "Frase repetida logo em seguida — sugerimos manter só a última tentativa.",
                    confianca="alta" if sim >= 0.75 else "media",
                    trecho=" … ".join(f["texto"] for f in frases[i:j])))
                usados.update(range(i, j))
                break
    # 2) Marcadores de erro / retomada ("peraí", "de novo", "errei"…)
    for i, f in enumerate(frases):
        n = " " + " ".join(norm[i]) + " "
        achou = next((m for m in MARCADORES_ERRO if f" {m} " in n), None)
        if not achou or i in usados:
            continue
        curta = len(norm[i]) <= 7
        ini = frases[i - 1]["ini"] if i > 0 and curta and (i - 1) not in usados \
            and f["ini"] - frases[i - 1]["fim"] < 2.5 else f["ini"]
        sugs.append(_sug(
            mid, "erro", ini - 0.05, f["fim"] + 0.05,
            f"Possível erro de fala ou retomada (“{achou}”). Confira se o trecho anterior "
            "deve sair junto.", confianca="media" if curta else "baixa",
            trecho=" … ".join(x["texto"] for x in frases[(i - 1 if ini < f["ini"] else i):i + 1])))
        usados.add(i)
    # 3) Gaguejos (palavra repetida em sequência) e hesitações isoladas
    for f in frases:
        ws = f["palavras"]
        for a, b in zip(ws, ws[1:]):
            na, nb = normalizar(a["p"]), normalizar(b["p"])
            if na and na == nb and len(na) > 2 and b["ini"] - a["fim"] < 0.6:
                sugs.append(_sug(mid, "gaguejo", a["ini"], b["ini"] - 0.02,
                                 f"Palavra repetida (“{a['p']} {b['p']}”).", confianca="baixa",
                                 trecho=f"{a['p']} {b['p']}"))
        for w in ws:
            if normalizar(w["p"]) in HESITACOES or w["p"].lower().strip(".,…") in HESITACOES:
                if w["fim"] - w["ini"] >= 0.25:
                    sugs.append(_sug(mid, "hesitacao", w["ini"], w["fim"],
                                     f"Hesitação (“{w['p']}”).", confianca="baixa", trecho=w["p"]))
    # 4) Fala pouco clara (sequência de palavras com baixa confiança) — só revisão
    for f in frases:
        seq = []
        for w in f["palavras"] + [None]:
            if w is not None and w["conf"] < 0.35:
                seq.append(w)
                continue
            if len(seq) >= 3:
                sugs.append(_sug(mid, "fala_confusa", seq[0]["ini"], seq[-1]["fim"],
                                 "Fala pouco clara ou palavra possivelmente errada. Revise o trecho.",
                                 acao="revisar", confianca="baixa",
                                 trecho=" ".join(x["p"] for x in seq)))
            seq = []
    return sugs


def sugestoes_de_audio(mid: str, duracao: float, pausas: list, sem_audio: list,
                       movimento: list, fala: list[list[float]], cfg: dict,
                       tem_audio: bool) -> list[dict]:
    """Pausas longas, inícios/finais parados e trechos sem áudio (preservando demonstrações)."""
    sugs = []
    lim_mov = float(cfg["movimento_min"])
    if not tem_audio:
        return [_sug(mid, "sem_audio", 0, duracao, "Este take não tem áudio. Use-o como imagem de "
                     "apoio (demonstração) ou junto com uma narração.", acao="manter",
                     confianca="alta")]
    primeira = fala[0][0] if fala else None
    ultima = fala[-1][1] if fala else None

    def tem_demo(a, b):
        return bool(movimento) and movimento_em(movimento, a, b) >= lim_mov

    def adicionar_parado(tipo, a, b, motivo_corte):
        if b - a < 0.6:
            return
        if tem_demo(a, b):
            sugs.append(_sug(mid, "demonstracao", a, b, "Sem fala, mas com movimento na imagem — "
                             "parece uma demonstração visual. Sugerimos MANTER.", acao="manter",
                             confianca="media"))
        else:
            sugs.append(_sug(mid, tipo, a, b, motivo_corte, confianca="alta"))

    if primeira is not None and primeira > 0.6:
        adicionar_parado("inicio_parado", 0, primeira - 0.15,
                         "Início sem fala antes de você começar — pode ser cortado.")
    if ultima is not None and duracao - ultima > 0.8:
        adicionar_parado("final_parado", ultima + 0.3, duracao,
                         "Final sem fala depois que você termina — pode ser cortado.")

    margem = 0.2
    for a, b in pausas:
        if primeira is not None and (b <= primeira + 0.05 or a >= ultima - 0.05):
            continue  # já tratado como início/final
        if b - a < float(cfg["pausa_min"]):
            continue
        ca, cb = a + margem, b - margem
        if tem_demo(a, b):
            sugs.append(_sug(mid, "demonstracao", a, b, f"Pausa de {b - a:.1f}s com movimento na "
                             "imagem — provável demonstração. Sugerimos MANTER.", acao="manter"))
        else:
            sugs.append(_sug(mid, "pausa", ca, cb, f"Pausa longa de {b - a:.1f}s — sugerimos "
                             f"encurtar (fica uma respiração de {margem * 2:.1f}s).",
                             confianca="alta" if b - a > 1.5 else "media"))
    for a, b in sem_audio:
        if b - a < 1.5:
            continue
        if any(s["ini"] <= a + 0.3 and s["fim"] >= b - 0.3 for s in sugs):
            continue
        if not tem_demo(a, b):
            sugs.append(_sug(mid, "sem_audio", a, b, "Trecho completamente sem áudio.",
                             confianca="media"))
    if not fala and tem_audio and movimento and tem_demo(0, duracao):
        sugs.append(_sug(mid, "demonstracao", 0, duracao, "Take sem fala com movimento — "
                         "use como demonstração visual.", acao="manter"))
    return sugs


def intervalos_de_fala(frases: list[dict], pausas: list, duracao: float) -> list[list[float]]:
    if frases:
        return [[f["ini"], f["fim"]] for f in frases]
    fala, t = [], 0.0
    for a, b in sorted(pausas):
        if a - t > 0.2:
            fala.append([t, a])
        t = b
    if duracao - t > 0.2:
        fala.append([t, duracao])
    return fala


def nota_take(duracao: float, frases: list, sugs: list, segmentos: list, fala: list) -> int:
    if duracao <= 0:
        return 0
    nota = 70.0
    tempo_fala = sum(b - a for a, b in fala)
    nota += 20 * min(1.0, tempo_fala / duracao / 0.8)
    for s in sugs:
        nota -= {"repeticao": 7, "erro": 9, "gaguejo": 2, "hesitacao": 1.5, "fala_confusa": 3,
                 "pausa": 2, "sem_audio": 4}.get(s["tipo"], 0)
    if segmentos:
        conf = sum(s["conf"] for s in segmentos) / len(segmentos)  # log-prob médio
        nota += max(-15, min(10, (conf + 0.6) * 25))
    return int(max(0, min(100, round(nota))))


# ------------------------------------------------------------ tarefa principal

def analisar(tarefa: Tarefa, pid: str, mid: str) -> dict:
    cfg = config.carregar()
    projeto = projetos.carregar(pid)
    m = projetos.midia(projeto, mid)
    if m.get("status") != "pronto":
        raise ErroAmigavel("Aguarde a importação do arquivo terminar antes de analisar.")
    origem = projetos.caminho_midia(pid, m)
    if not origem.exists():
        raise ErroAmigavel(f"O arquivo original “{m['nome']}” não foi encontrado.")
    pasta = projetos.pasta(pid) / "analise"
    pasta.mkdir(exist_ok=True)
    dur = float(m["duracao"])
    tem_audio = bool(m.get("tem_audio"))
    eh_video = m["tipo"] == "video"

    pausas, sem_audio = [], []
    if tem_audio:
        pausas = detectar_silencios(origem, cfg["silencio_db"], 0.3, dur, tarefa, (0.0, 0.12))
        sem_audio = detectar_silencios(origem, cfg["sem_audio_db"], 1.0, dur, tarefa, (0.12, 0.2))
    movimento = []
    if eh_video:
        proxy = projetos.pasta(pid) / "cache" / m["proxy"]
        movimento = medir_movimento(proxy, pasta, dur, tarefa, (0.2, 0.3))

    trans = {"segmentos": [], "idioma": None}
    aviso = None
    if tem_audio:
        if transcricao.disponivel():
            trans = transcricao.transcrever(tarefa, origem, pasta, dur, (0.3, 0.95))
        else:
            aviso = ("Transcrição indisponível (Faster-Whisper não encontrado). Foram analisadas "
                     "apenas pausas, silêncios e movimento.")

    tarefa.avancar(0.96, "Procurando repetições, erros e melhores trechos…")
    frases = montar_frases(trans["segmentos"])
    fala = intervalos_de_fala(frases, pausas, dur)
    sugs = sugestoes_de_audio(mid, dur, pausas, sem_audio, movimento, fala, cfg, tem_audio)
    sugs += sugestoes_de_fala(mid, frases)
    sugs.sort(key=lambda s: s["ini"])
    nota = nota_take(dur, frases, sugs, trans["segmentos"], fala)

    detalhe = {"transcricao": trans, "frases": frases, "pausas": pausas, "sem_audio": sem_audio,
               "movimento": movimento, "fala": fala}
    config.gravar_json(pasta / f"{mid}.json", detalhe)

    texto = " ".join(f["texto"] for f in frases)
    resumo = {
        "nota": nota, "texto": texto, "aviso": aviso,
        "tempo_fala": round(sum(b - a for a, b in fala), 2),
        "pausas": sum(1 for s in sugs if s["tipo"] == "pausa"),
        "repeticoes": sum(1 for s in sugs if s["tipo"] == "repeticao"),
        "erros": sum(1 for s in sugs if s["tipo"] in ("erro", "gaguejo", "fala_confusa")),
        "demonstracoes": sum(1 for s in sugs if s["tipo"] == "demonstracao"),
        "movimento": round(movimento_em(movimento, 0, dur), 4) if movimento else 0,
        # trechos sem nenhum áudio (usados para mostrar "vídeo sem áudio" na timeline)
        "silencios": [s for s in sem_audio if s[1] - s[0] >= 1.0] if tem_audio else [[0, dur]],
        "inicio_fala": fala[0][0] if fala else None,
        "fim_fala": fala[-1][1] if fala else None,
    }

    def aplicar(p):
        alvo = projetos.midia(p, mid)
        alvo["analise"] = resumo
        alvo["analisado"] = True
        # substitui sugestões pendentes antigas deste take, mantendo as já decididas
        decididas = [s for s in p.get("sugestoes", []) if s["midia"] == mid and s["status"] != "pendente"]
        chaves = {(s["tipo"], round(s["ini"], 1), round(s["fim"], 1)) for s in decididas}
        outras = [s for s in p.get("sugestoes", []) if s["midia"] != mid]
        novas = [s for s in sugs if (s["tipo"], round(s["ini"], 1), round(s["fim"], 1)) not in chaves]
        p["sugestoes"] = outras + decididas + novas
        agrupar_takes(p)
    projetos.alterar(pid, aplicar)
    tarefa.avancar(1.0, f"Análise concluída — {len(sugs)} sugestões para revisar")
    return {"sugestoes": len(sugs), "nota": nota}


def agrupar_takes(projeto: dict) -> None:
    """Agrupa takes com falas parecidas (tentativas do mesmo trecho) e marca o melhor."""
    takes = [m for m in projeto.get("midias", []) if m.get("tipo") == "video" and m.get("analise")]
    textos = {m["id"]: normalizar(m["analise"].get("texto", "")).split() for m in takes}
    grupo: dict[str, int] = {}
    n = 0
    for i, a in enumerate(takes):
        if a["id"] in grupo:
            continue
        n += 1
        grupo[a["id"]] = n
        for b in takes[i + 1:]:
            if b["id"] in grupo or not textos[a["id"]] or not textos[b["id"]]:
                continue
            if SequenceMatcher(None, textos[a["id"]], textos[b["id"]]).ratio() >= 0.5:
                grupo[b["id"]] = n
    for m in takes:
        m["analise"]["grupo"] = grupo[m["id"]]
        irmaos = [t for t in takes if grupo[t["id"]] == grupo[m["id"]]]
        melhor = max(irmaos, key=lambda t: (t["analise"]["nota"], t.get("duracao", 0)))
        m["analise"]["alternativas"] = len(irmaos) - 1
        m["analise"]["melhor"] = melhor["id"] == m["id"]


def carregar_detalhe(pid: str, mid: str) -> dict | None:
    arq = projetos.pasta(pid) / "analise" / f"{mid}.json"
    if not arq.exists():
        return None
    return json.loads(arq.read_text(encoding="utf-8"))
