"""Armazenamento de projetos.

Estrutura de cada projeto (``dados/projetos/<id>/``)::

    projeto.json        dados do projeto (timeline, legendas, sugestões…)
    projeto.json.bak    cópia de segurança da versão anterior
    originais/          cópias dos arquivos importados pelo navegador
    cache/              proxies leves, miniaturas, formas de onda
    analise/            transcrições e medições de cada take
    exportacoes/        vídeos exportados

Arquivos originais NUNCA são alterados: só lemos deles. Os arquivos referenciados
"sem copiar" ficam onde estão no computador.
"""
from __future__ import annotations

import json
import re
import shutil
import threading
import time
import unicodedata
import uuid
from pathlib import Path

from . import config

_travas: dict[str, threading.RLock] = {}
_trava_global = threading.Lock()

CAMPOS_EDITAVEIS = {"nome", "briefing", "timeline", "legenda_estilo", "sugestoes_estado",
                    "montagem", "editor"}


def trava(pid: str) -> threading.RLock:
    with _trava_global:
        return _travas.setdefault(pid, threading.RLock())


def novo_id(prefixo: str = "") -> str:
    return prefixo + uuid.uuid4().hex[:10]


def pasta(pid: str) -> Path:
    if not re.fullmatch(r"[a-z0-9_-]{4,64}", pid or ""):
        raise KeyError("Projeto inválido")
    return config.PASTA_PROJETOS / pid


def _arquivo(pid: str) -> Path:
    return pasta(pid) / "projeto.json"


def estilo_legenda_padrao() -> dict:
    return {
        "fonte": "Arial", "tamanho": 64, "cor": "#FFFFFF", "contorno": "#000000",
        "espessura": 4, "fundo": False, "cor_fundo": "#000000", "negrito": True,
        "posicao": "baixo", "margem": 260, "max_palavras": 5, "ativar": True,
    }


def criar(nome: str, briefing: dict | None = None) -> dict:
    nome = (nome or "").strip() or "Projeto sem nome"
    base = unicodedata.normalize("NFKD", nome).encode("ascii", "ignore").decode().lower()
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-")[:30] or "projeto"
    pid = f"{base}-{uuid.uuid4().hex[:6]}"
    p = pasta(pid)
    for sub in ("originais", "cache", "analise", "exportacoes"):
        (p / sub).mkdir(parents=True, exist_ok=True)
    agora = time.time()
    projeto = {
        "id": pid, "nome": nome, "criado": agora, "atualizado": agora, "versao": 1,
        "briefing": {
            "produto": "", "marca": "", "publico": "", "beneficios": "", "cta": "",
            "observacoes": "", **(briefing or {}),
        },
        "midias": [],
        "timeline": {"clipes": [], "textos": [], "legendas": []},
        "legenda_estilo": estilo_legenda_padrao(),
        "sugestoes": [],
        "montagem": None,
        "exportacoes": [],
        "editor": {"zoom": 60, "modo_sinc": "tudo"},
    }
    with trava(pid):
        config.gravar_json(_arquivo(pid), projeto)
    return projeto


def carregar(pid: str) -> dict:
    arq = _arquivo(pid)
    if not arq.exists():
        raise KeyError("Projeto não encontrado")
    with trava(pid):
        try:
            return json.loads(arq.read_text(encoding="utf-8"))
        except ValueError:
            bak = arq.with_suffix(".json.bak")
            if bak.exists():  # recupera a última versão boa
                return json.loads(bak.read_text(encoding="utf-8"))
            raise


def _gravar(projeto: dict) -> None:
    arq = _arquivo(projeto["id"])
    if arq.exists():
        try:
            shutil.copyfile(arq, arq.with_suffix(".json.bak"))
        except OSError:
            pass
    projeto["atualizado"] = time.time()
    projeto["versao"] = int(projeto.get("versao", 0)) + 1
    config.gravar_json(arq, projeto)


def alterar(pid: str, funcao) -> dict:
    """Aplica ``funcao(projeto)`` sob trava e grava. Devolve o projeto atualizado."""
    with trava(pid):
        projeto = carregar(pid)
        funcao(projeto)
        _gravar(projeto)
        return projeto


def salvar_edicao(pid: str, dados: dict) -> dict:
    """Salvamento automático vindo do editor: só campos editáveis pelo usuário."""
    def aplicar(projeto):
        for chave, valor in dados.items():
            if chave == "sugestoes_estado":
                estados = {s["id"]: s for s in valor if isinstance(s, dict) and "id" in s}
                for sug in projeto.get("sugestoes", []):
                    if sug["id"] in estados:
                        sug["status"] = estados[sug["id"]].get("status", sug.get("status"))
            elif chave in CAMPOS_EDITAVEIS:
                projeto[chave] = valor
    return alterar(pid, aplicar)


def listar() -> list[dict]:
    itens = []
    if not config.PASTA_PROJETOS.exists():
        return itens
    for arq in config.PASTA_PROJETOS.glob("*/projeto.json"):
        try:
            p = json.loads(arq.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        capa = next((m for m in p.get("midias", []) if m.get("miniatura")), None)
        itens.append({
            "id": p["id"], "nome": p.get("nome"), "criado": p.get("criado"),
            "atualizado": p.get("atualizado"),
            "takes": sum(1 for m in p.get("midias", []) if m.get("tipo") == "video"),
            "audios": sum(1 for m in p.get("midias", []) if m.get("tipo") == "audio"),
            "duracao": duracao_timeline(p.get("timeline", {})),
            "capa": f"/arquivo/{p['id']}/{capa['id']}/miniatura" if capa else None,
            "produto": p.get("briefing", {}).get("produto", ""),
        })
    return sorted(itens, key=lambda i: i.get("atualizado") or 0, reverse=True)


def excluir(pid: str) -> None:
    """Remove a pasta do projeto (cópias, cache, exportações).

    Arquivos referenciados "sem copiar" ficam fora dessa pasta e nunca são tocados.
    """
    p = pasta(pid)
    if not (p / "projeto.json").exists():
        raise KeyError("Projeto não encontrado")
    with trava(pid):
        shutil.rmtree(p)


def duplicar(pid: str) -> dict:
    original = carregar(pid)
    novo = criar(original["nome"] + " (cópia)", original.get("briefing"))
    destino = pasta(novo["id"])
    origem = pasta(pid)
    for sub in ("originais", "cache", "analise"):
        if (origem / sub).exists():
            shutil.copytree(origem / sub, destino / sub, dirs_exist_ok=True)

    def aplicar(p):
        for chave in ("midias", "timeline", "legenda_estilo", "sugestoes", "montagem", "editor"):
            p[chave] = original.get(chave)
    return alterar(novo["id"], aplicar)


def midia(projeto: dict, mid: str) -> dict:
    for m in projeto.get("midias", []):
        if m["id"] == mid:
            return m
    raise KeyError("Mídia não encontrada no projeto")


def caminho_midia(pid: str, m: dict) -> Path:
    """Caminho do arquivo original (cópia no projeto ou referência externa)."""
    if m.get("externo"):
        return Path(m["arquivo"])
    return pasta(pid) / m["arquivo"]


def duracao_timeline(tl: dict) -> float:
    fim = 0.0
    for c in tl.get("clipes", []):
        fim = max(fim, float(c.get("pos", 0)) + float(c.get("fim", 0)) - float(c.get("ini", 0)))
    for t in tl.get("textos", []):
        fim = max(fim, float(t.get("pos", 0)) + float(t.get("dur", 0)))
    return round(fim, 3)
