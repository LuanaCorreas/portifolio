"""Transcrição em português com Faster-Whisper (modelo tiny, CPU, int8).

O modelo é carregado só quando necessário e liberado quando a fila fica vazia,
para economizar memória num computador com 8 GB.
"""
from __future__ import annotations

import gc
import threading
from pathlib import Path

from . import config
from .tarefas import ErroAmigavel, Tarefa, rodar_ffmpeg

_modelo = None
_chave_modelo = None
_trava = threading.Lock()


def disponivel() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _obter_modelo(tarefa: Tarefa):
    global _modelo, _chave_modelo
    cfg = config.carregar()
    nome = cfg["whisper_pasta_modelo"] or cfg["whisper_modelo"] or "tiny"
    chave = (nome, cfg["whisper_compute"], int(cfg["whisper_threads"]))
    with _trava:
        if _modelo is not None and _chave_modelo == chave:
            return _modelo
        liberar()
        try:
            from faster_whisper import WhisperModel
        except Exception as erro:  # noqa: BLE001
            raise ErroAmigavel(
                "O Faster-Whisper não está instalado neste Python, então não é possível "
                "transcrever. As outras análises (pausas e silêncios) continuam funcionando."
            ) from erro
        tarefa.avancar(None, "Carregando modelo de transcrição (Whisper tiny)…")
        try:
            _modelo = WhisperModel(nome, device="cpu", compute_type=chave[1],
                                   cpu_threads=chave[2], num_workers=1)
        except Exception as erro:  # noqa: BLE001
            raise ErroAmigavel(
                "Não consegui carregar o modelo Whisper. Na primeira vez ele precisa ser "
                "baixado (cerca de 75 MB) com internet ligada; ou informe em Configurações "
                f"a pasta onde o modelo já está salvo. Detalhe: {erro}"
            ) from erro
        _chave_modelo = chave
        return _modelo


def liberar():
    global _modelo, _chave_modelo
    _modelo = None
    _chave_modelo = None
    gc.collect()


def transcrever(tarefa: Tarefa, origem: Path, pasta_tmp: Path, duracao: float,
                faixa: tuple[float, float] = (0.3, 0.95)) -> dict:
    """Devolve {'segmentos': [{ini, fim, texto, conf, palavras:[{ini,fim,p,conf}]}], 'idioma'}."""
    cfg = config.carregar()
    a, b = faixa
    wav = pasta_tmp / "_audio16k.wav"
    tarefa.avancar(a, "Extraindo áudio para transcrição…")
    rodar_ffmpeg(["-i", str(origem), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                  str(wav)])
    try:
        modelo = _obter_modelo(tarefa)
        tarefa.avancar(a + 0.02, "Transcrevendo suas falas…")
        segmentos_iter, info = modelo.transcribe(
            str(wav), language=cfg["idioma"] or "pt", task="transcribe",
            beam_size=int(cfg["whisper_beam"]), best_of=1, word_timestamps=True,
            vad_filter=bool(cfg["whisper_vad"]), condition_on_previous_text=False,
            # Sem prompt: não queremos que o modelo "corrija" ou invente falas.
        )
        segmentos = []
        for seg in segmentos_iter:
            palavras = [
                {"ini": round(w.start, 3), "fim": round(w.end, 3), "p": w.word.strip(),
                 "conf": round(float(w.probability), 3)}
                for w in (seg.words or []) if w.word.strip()
            ]
            segmentos.append({
                "ini": round(seg.start, 3), "fim": round(seg.end, 3), "texto": seg.text.strip(),
                "conf": round(float(seg.avg_logprob), 3),
                "sem_fala": round(float(seg.no_speech_prob), 3), "palavras": palavras,
            })
            if duracao > 0:
                tarefa.avancar(a + 0.02 + (b - a - 0.02) * min(1.0, seg.end / duracao),
                               f"Transcrevendo… {_tempo(seg.end)} de {_tempo(duracao)}")
        return {"segmentos": segmentos, "idioma": getattr(info, "language", "pt")}
    finally:
        try:
            wav.unlink()
        except OSError:
            pass


def _tempo(s: float) -> str:
    s = int(s)
    return f"{s // 60}:{s % 60:02d}"
