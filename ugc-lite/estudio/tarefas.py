"""Fila de tarefas em segundo plano.

Uma única linha de execução processa uma tarefa por vez (importante para um
i3 com 8 GB de RAM). Cada tarefa informa progresso (0–1) e uma mensagem em
português que a interface mostra numa barra de progresso.
"""
from __future__ import annotations

import itertools
import queue
import re
import subprocess
import threading
import time
import traceback
from typing import Callable

from . import config


class Cancelada(Exception):
    pass


class ErroAmigavel(Exception):
    """Erro com mensagem pronta para mostrar ao usuário."""


class Tarefa:
    _ids = itertools.count(1)

    def __init__(self, tipo: str, titulo: str, projeto: str | None, funcao: Callable, **meta):
        self.id = f"t{next(self._ids)}"
        self.tipo = tipo
        self.titulo = titulo
        self.projeto = projeto
        self.funcao = funcao
        self.meta = meta
        self.estado = "na_fila"  # na_fila | executando | concluida | erro | cancelada
        self.progresso = 0.0
        self.mensagem = "Aguardando na fila…"
        self.erro: str | None = None
        self.resultado = None
        self.criada = time.time()
        self.fim: float | None = None
        self._cancelar = threading.Event()
        self._processo: subprocess.Popen | None = None

    # usado pelas funções de trabalho
    def avancar(self, progresso: float | None = None, mensagem: str | None = None):
        if self._cancelar.is_set():
            raise Cancelada()
        if progresso is not None:
            self.progresso = max(0.0, min(1.0, float(progresso)))
        if mensagem is not None:
            self.mensagem = mensagem

    @property
    def cancelada(self) -> bool:
        return self._cancelar.is_set()

    def cancelar(self):
        self._cancelar.set()
        proc = self._processo
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass

    def como_dict(self) -> dict:
        return {
            "id": self.id, "tipo": self.tipo, "titulo": self.titulo, "projeto": self.projeto,
            "estado": self.estado, "progresso": round(self.progresso, 4),
            "mensagem": self.mensagem, "erro": self.erro, "criada": self.criada, "fim": self.fim,
            "resultado": self.resultado if isinstance(self.resultado, (dict, str, type(None))) else None,
            **{k: v for k, v in self.meta.items() if isinstance(v, (str, int, float, bool))},
        }


class Fila:
    def __init__(self):
        self._fila: "queue.Queue[Tarefa]" = queue.Queue()
        self._todas: dict[str, Tarefa] = {}
        self._trava = threading.Lock()
        self._ao_ficar_ociosa: list[Callable] = []
        self._linha = threading.Thread(target=self._executar, name="fila-tarefas", daemon=True)
        self._linha.start()

    def ao_ficar_ociosa(self, funcao: Callable):
        self._ao_ficar_ociosa.append(funcao)

    def adicionar(self, tarefa: Tarefa) -> Tarefa:
        with self._trava:
            self._todas[tarefa.id] = tarefa
        self._fila.put(tarefa)
        return tarefa

    def obter(self, tid: str) -> Tarefa | None:
        return self._todas.get(tid)

    def listar(self, projeto: str | None = None) -> list[dict]:
        limite = time.time() - 3600
        with self._trava:
            # limpa tarefas finalizadas há mais de 1 hora
            for tid in [t.id for t in self._todas.values() if t.fim and t.fim < limite]:
                self._todas.pop(tid, None)
            itens = list(self._todas.values())
        if projeto:
            itens = [t for t in itens if t.projeto == projeto]
        return [t.como_dict() for t in sorted(itens, key=lambda t: t.criada)]

    def pendente(self, tipo: str, projeto: str, **filtro) -> Tarefa | None:
        for t in self._todas.values():
            if t.tipo == tipo and t.projeto == projeto and t.estado in ("na_fila", "executando") \
                    and all(t.meta.get(k) == v for k, v in filtro.items()):
                return t
        return None

    def _executar(self):
        while True:
            tarefa = self._fila.get()
            if tarefa.cancelada:
                tarefa.estado, tarefa.mensagem, tarefa.fim = "cancelada", "Cancelada", time.time()
                continue
            tarefa.estado = "executando"
            tarefa.mensagem = "Iniciando…"
            try:
                tarefa.resultado = tarefa.funcao(tarefa)
                tarefa.estado = "concluida"
                tarefa.progresso = 1.0
                if not tarefa.mensagem or tarefa.mensagem.endswith("…"):
                    tarefa.mensagem = "Concluído"
            except Cancelada:
                tarefa.estado, tarefa.mensagem = "cancelada", "Cancelada pelo usuário"
            except (ErroAmigavel, config.FerramentaAusente) as erro:
                tarefa.estado, tarefa.erro = "erro", str(erro)
                tarefa.mensagem = "Não foi possível concluir"
            except MemoryError:
                tarefa.estado = "erro"
                tarefa.erro = ("Memória insuficiente. Feche outros programas (navegador com muitas "
                               "abas, por exemplo) e tente novamente.")
            except Exception as erro:  # noqa: BLE001
                traceback.print_exc()
                tarefa.estado = "erro"
                tarefa.erro = f"Erro inesperado: {erro}"
                tarefa.mensagem = "Não foi possível concluir"
            finally:
                tarefa.fim = time.time()
                tarefa._processo = None
            if self._fila.empty():
                for funcao in self._ao_ficar_ociosa:
                    try:
                        funcao()
                    except Exception:  # noqa: BLE001
                        traceback.print_exc()


FILA = Fila()


# ------------------------------------------------- execução de FFmpeg

LIMITE_SEM_PROGRESSO = 180
_RE_TEMPO = re.compile(r"out_time_(?:us|ms)=(\d+)")


def rodar_ffmpeg(args: list[str], tarefa: Tarefa | None = None, duracao: float = 0.0,
                 faixa: tuple[float, float] = (0.0, 1.0), mensagem: str | None = None,
                 cwd: str | None = None) -> str:
    """Executa o FFmpeg informando progresso. Devolve o stderr (para análises)."""
    cmd = [config.ffmpeg(), "-hide_banner", "-nostdin", "-y"]
    if tarefa is not None and duracao > 0:
        cmd += ["-progress", "pipe:1", "-nostats"]
    cmd += args
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd,
        creationflags=config.FLAGS_PROCESSO, text=True, encoding="utf-8", errors="replace",
    )
    if tarefa is not None:
        tarefa._processo = proc
    stderr_partes: list[str] = []
    leitor = threading.Thread(target=lambda: stderr_partes.append(proc.stderr.read()), daemon=True)
    leitor.start()
    a, b = faixa
    # Vigia: se o FFmpeg ficar 3 minutos sem avançar, encerra com mensagem clara.
    estado = {"ultimo": time.time(), "travou": False}

    def vigiar():
        while proc.poll() is None:
            if time.time() - estado["ultimo"] > LIMITE_SEM_PROGRESSO:
                estado["travou"] = True
                proc.kill()
                return
            time.sleep(2)
    if tarefa is not None and duracao > 0:
        threading.Thread(target=vigiar, daemon=True).start()
    for linha in proc.stdout:
        estado["ultimo"] = time.time()
        if tarefa is None or duracao <= 0:
            continue
        m = _RE_TEMPO.search(linha)
        if m:
            seg = int(m.group(1)) / 1_000_000
            tarefa.avancar(a + (b - a) * min(1.0, seg / duracao), mensagem)
    proc.wait()
    leitor.join(timeout=5)
    proc.stdout.close()
    proc.stderr.close()
    stderr = "".join(stderr_partes)
    if tarefa is not None:
        if tarefa.cancelada:
            raise Cancelada()
        tarefa._processo = None
    if estado["travou"]:
        raise ErroAmigavel("O FFmpeg parou de responder e a tarefa foi interrompida. Tente de novo; "
                           "se repetir, reinicie o aplicativo.")
    if proc.returncode != 0:
        raise ErroAmigavel(traduzir_erro_ffmpeg(stderr))
    return stderr


def traduzir_erro_ffmpeg(stderr: str) -> str:
    s = stderr.lower()
    if "no such file" in s:
        return "O arquivo de mídia não foi encontrado. Ele pode ter sido movido ou renomeado."
    if "invalid data found" in s or "moov atom not found" in s:
        return "O arquivo parece estar corrompido ou incompleto e o FFmpeg não conseguiu lê-lo."
    if "permission denied" in s:
        return "Sem permissão para ler ou gravar o arquivo. Verifique se ele está aberto em outro programa."
    if "no space left" in s:
        return "Não há espaço livre suficiente no disco."
    if "no such filter" in s and ("'ass'" in s or "subtitles" in s):
        return ("Esta versão do FFmpeg não grava legendas (falta a biblioteca libass). Exporte sem "
                "legendas ou instale a versão “full” do FFmpeg (gyan.dev).")
    if "unknown encoder" in s or "encoder not found" in s:
        return "O codificador de vídeo não está disponível nesta versão do FFmpeg."
    if "qsv" in s and ("error" in s or "failed" in s):
        return ("A aceleração Intel Quick Sync falhou. Desative-a em Configurações para usar "
                "a codificação por CPU.")
    ultimas = [l for l in stderr.strip().splitlines() if l.strip()][-3:]
    return "O FFmpeg informou um erro: " + " | ".join(ultimas)[-400:]
