"""Configurações do aplicativo e detecção de ferramentas (FFmpeg / Faster-Whisper).

Tudo fica em ``dados/config.json``. Nada aqui altera arquivos de vídeo do usuário.
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

RAIZ_APP = Path(__file__).resolve().parent.parent
PASTA_WEB = RAIZ_APP / "web"
PASTA_DADOS = Path(os.environ.get("UGC_LITE_DADOS", RAIZ_APP / "dados")).resolve()
PASTA_PROJETOS = PASTA_DADOS / "projetos"
ARQUIVO_CONFIG = PASTA_DADOS / "config.json"

EH_WINDOWS = sys.platform.startswith("win")
# Evita abrir janelas pretas de console a cada chamada do FFmpeg no Windows.
FLAGS_PROCESSO = 0x08000000 if EH_WINDOWS else 0  # CREATE_NO_WINDOW

PADRAO = {
    "ffmpeg": "",            # vazio = detectar automaticamente
    "ffprobe": "",
    "porta": 8765,
    "abrir_navegador": True,
    # Transcrição (otimizado para i3 + 8 GB: modelo tiny, CPU, int8)
    "whisper_modelo": "tiny",
    "whisper_pasta_modelo": "",  # opcional: pasta local com o modelo já baixado
    "whisper_compute": "int8",
    "whisper_threads": 4,
    "whisper_beam": 1,
    "whisper_vad": True,
    "idioma": "pt",
    # Análise
    "pausa_min": 0.8,          # segundos de silêncio considerados "pausa longa"
    "silencio_db": -35,        # limiar de silêncio entre falas
    "sem_audio_db": -55,       # limiar de "sem áudio" (silêncio total)
    "movimento_min": 0.012,    # intensidade de movimento que indica demonstração visual
    # Pré-visualização (proxies leves para o editor)
    "proxy_altura": 640,
    # Exportação
    "export_largura": 1080,
    "export_altura": 1920,
    "export_fps": 30,
    "export_crf": 20,
    "export_preset": "veryfast",
    "export_audio_kbps": 160,
    "export_enquadramento": "preencher",  # preencher (corta bordas) | ajustar (barras)
    "export_quicksync": False,             # Intel Quick Sync (experimental)
    "export_normalizar": True,             # volume padrão de redes sociais (-14 LUFS)
    "export_pasta": "",                    # vazio = pasta do projeto
    "previa_largura": 540,
    "previa_altura": 960,
}

_trava = threading.Lock()
_cache: dict | None = None


def carregar() -> dict:
    global _cache
    with _trava:
        if _cache is None:
            dados = {}
            if ARQUIVO_CONFIG.exists():
                try:
                    dados = json.loads(ARQUIVO_CONFIG.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    dados = {}
            _cache = {**PADRAO, **{k: v for k, v in dados.items() if k in PADRAO}}
        return dict(_cache)


def salvar(novos: dict) -> dict:
    global _cache
    atual = carregar()
    for chave, valor in novos.items():
        if chave not in PADRAO:
            continue
        padrao = PADRAO[chave]
        try:
            if isinstance(padrao, bool):
                valor = bool(valor)
            elif isinstance(padrao, int):
                valor = int(valor)
            elif isinstance(padrao, float):
                valor = float(valor)
            else:
                valor = str(valor).strip()
        except (TypeError, ValueError):
            continue
        atual[chave] = valor
    PASTA_DADOS.mkdir(parents=True, exist_ok=True)
    gravar_json(ARQUIVO_CONFIG, atual)
    with _trava:
        _cache = atual
    return dict(atual)


def gravar_json(caminho: Path, dados) -> None:
    """Gravação atômica: escreve em arquivo temporário e substitui."""
    caminho = Path(caminho)
    tmp = caminho.with_suffix(caminho.suffix + ".tmp")
    tmp.write_text(json.dumps(dados, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, caminho)


# ---------------------------------------------------------------- FFmpeg

def _candidatos_windows(nome: str) -> list[str]:
    padroes = [
        rf"C:\ffmpeg\bin\{nome}.exe",
        rf"C:\Program Files\ffmpeg\bin\{nome}.exe",
        os.path.expandvars(rf"%LOCALAPPDATA%\Microsoft\WinGet\Packages\*FFmpeg*\*\bin\{nome}.exe"),
        os.path.expandvars(rf"%LOCALAPPDATA%\Microsoft\WinGet\Links\{nome}.exe"),
        os.path.expandvars(rf"%USERPROFILE%\scoop\shims\{nome}.exe"),
        rf"C:\ProgramData\chocolatey\bin\{nome}.exe",
    ]
    achados = []
    for p in padroes:
        achados.extend(sorted(glob.glob(p)))
    return achados


def localizar(nome: str) -> str | None:
    cfg = carregar()
    manual = cfg.get(nome) or ""
    if manual and Path(manual).is_file():
        return manual
    via_path = shutil.which(nome)
    if via_path:
        return via_path
    if EH_WINDOWS:
        for c in _candidatos_windows(nome):
            if Path(c).is_file():
                return c
    # Mesmo diretório do ffmpeg configurado (ex.: ffprobe ao lado do ffmpeg)
    if nome == "ffprobe" and cfg.get("ffmpeg"):
        irmao = Path(cfg["ffmpeg"]).with_name("ffprobe" + (".exe" if EH_WINDOWS else ""))
        if irmao.is_file():
            return str(irmao)
    return None


class FerramentaAusente(RuntimeError):
    pass


def ffmpeg() -> str:
    c = localizar("ffmpeg")
    if not c:
        raise FerramentaAusente(
            "Não encontrei o FFmpeg no computador. Abra Configurações e informe o "
            "caminho do arquivo ffmpeg.exe (ex.: C:\\ffmpeg\\bin\\ffmpeg.exe)."
        )
    return c


def ffprobe() -> str:
    c = localizar("ffprobe")
    if not c:
        raise FerramentaAusente(
            "Não encontrei o FFprobe (vem junto com o FFmpeg). Em Configurações, "
            "informe o caminho do ffprobe.exe."
        )
    return c


def diagnostico() -> dict:
    """Verifica o que está disponível, para mostrar na tela inicial."""
    info = {"python": sys.version.split()[0], "plataforma": sys.platform}
    for nome in ("ffmpeg", "ffprobe"):
        caminho = localizar(nome)
        versao = None
        if caminho:
            try:
                saida = subprocess.run(
                    [caminho, "-version"], capture_output=True, text=True, timeout=10,
                    creationflags=FLAGS_PROCESSO, encoding="utf-8", errors="replace",
                ).stdout
                versao = saida.splitlines()[0] if saida else "?"
            except Exception:  # noqa: BLE001
                versao = None
        info[nome] = {"ok": bool(caminho and versao), "caminho": caminho, "versao": versao}
    try:
        import faster_whisper  # noqa: F401

        info["whisper"] = {"ok": True, "versao": getattr(faster_whisper, "__version__", "?")}
    except Exception as erro:  # noqa: BLE001
        info["whisper"] = {
            "ok": False,
            "versao": None,
            "erro": "Faster-Whisper não está disponível neste Python "
                    f"({type(erro).__name__}). A transcrição ficará desativada; "
                    "o restante do editor funciona normalmente.",
        }
    return info
