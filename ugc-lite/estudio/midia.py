"""Leitura de metadados e geração de arquivos auxiliares (sempre em ``cache/``).

* miniatura (.jpg) e tira de quadros para a timeline;
* proxy leve (.mp4 / .m4a) para reprodução fluida no editor de um i3;
* forma de onda (picos de volume) para desenhar o áudio na timeline.

O arquivo original é apenas LIDO.
"""
from __future__ import annotations

import json
import math
import subprocess
from array import array
from pathlib import Path

from . import config, projetos
from .tarefas import ErroAmigavel, Tarefa, rodar_ffmpeg

EXT_VIDEO = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".3gp", ".mts", ".m2ts", ".wmv"}
EXT_AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wma", ".amr"}
PICOS_POR_SEG = 50


def tipo_por_extensao(nome: str) -> str | None:
    ext = Path(nome).suffix.lower()
    if ext in EXT_VIDEO:
        return "video"
    if ext in EXT_AUDIO:
        return "audio"
    return None


def sondar(caminho: Path) -> dict:
    """Usa o ffprobe para descobrir duração, resolução, formato etc."""
    try:
        r = subprocess.run(
            [config.ffprobe(), "-v", "error", "-print_format", "json", "-show_format",
             "-show_streams", str(caminho)],
            capture_output=True, text=True, timeout=60, creationflags=config.FLAGS_PROCESSO,
            encoding="utf-8", errors="replace",
        )
    except subprocess.TimeoutExpired as erro:
        raise ErroAmigavel("O arquivo demorou demais para ser lido.") from erro
    if r.returncode != 0:
        raise ErroAmigavel("Não consegui ler este arquivo. Ele pode estar corrompido ou "
                           "em um formato não suportado.")
    dados = json.loads(r.stdout or "{}")
    fmt = dados.get("format", {})
    video = next((s for s in dados.get("streams", []) if s.get("codec_type") == "video"
                  and not s.get("disposition", {}).get("attached_pic")), None)
    audio = next((s for s in dados.get("streams", []) if s.get("codec_type") == "audio"), None)
    duracao = float(fmt.get("duration") or (video or audio or {}).get("duration") or 0)
    info = {
        "duracao": round(duracao, 3),
        "formato": (fmt.get("format_long_name") or fmt.get("format_name") or "").split(",")[0],
        "conteiner": Path(caminho).suffix.lower().lstrip("."),
        "tamanho": int(fmt.get("size") or 0),
        "tem_video": video is not None,
        "tem_audio": audio is not None,
    }
    if video:
        w, h = int(video.get("width") or 0), int(video.get("height") or 0)
        rot = 0
        try:
            rot = int(video.get("tags", {}).get("rotate", 0))
        except ValueError:
            pass
        for sd in video.get("side_data_list", []) or []:
            if "rotation" in sd:
                try:
                    rot = int(float(sd["rotation"]))
                except ValueError:
                    pass
        if abs(rot) % 180 == 90:
            w, h = h, w
        num, _, den = (video.get("avg_frame_rate") or "0/1").partition("/")
        try:
            fps = float(num) / float(den or 1)
        except (ValueError, ZeroDivisionError):
            fps = 0.0
        info.update({
            "largura": w, "altura": h, "rotacao": rot, "fps": round(fps, 2),
            "codec_video": video.get("codec_name"),
            "orientacao": "vertical" if h > w else ("horizontal" if w > h else "quadrado"),
        })
    if audio:
        info.update({
            "codec_audio": audio.get("codec_name"),
            "canais": int(audio.get("channels") or 0),
            "taxa_audio": int(audio.get("sample_rate") or 0),
        })
    if duracao <= 0:
        raise ErroAmigavel("Não consegui identificar a duração deste arquivo.")
    return info


def preparar(tarefa: Tarefa, pid: str, mid: str) -> dict:
    """Tarefa de importação: sonda, gera miniatura, proxy, tira de quadros e forma de onda."""
    projeto = projetos.carregar(pid)
    m = projetos.midia(projeto, mid)
    origem = projetos.caminho_midia(pid, m)
    if not origem.exists():
        raise ErroAmigavel(f"O arquivo “{m['nome']}” não foi encontrado em {origem}.")
    cache = projetos.pasta(pid) / "cache"
    cache.mkdir(parents=True, exist_ok=True)

    tarefa.avancar(0.02, "Lendo informações do arquivo…")
    info = sondar(origem)
    tipo = m["tipo"]
    if tipo == "video" and not info["tem_video"]:
        tipo = "audio"
    if tipo == "audio" and not info["tem_audio"]:
        raise ErroAmigavel("Este arquivo não possui faixa de áudio.")
    dur = info["duracao"]
    cfg = config.carregar()
    resultado = {**info, "tipo": tipo}

    if tipo == "video":
        tarefa.avancar(0.05, "Gerando miniatura…")
        mini = cache / f"{mid}_mini.jpg"
        rodar_ffmpeg(["-ss", f"{min(1.0, dur / 3):.2f}", "-i", str(origem), "-frames:v", "1",
                      "-vf", "scale=-2:360", "-q:v", "4", str(mini)])
        resultado["miniatura"] = mini.name

        tarefa.avancar(0.08, "Criando versão leve para edição…")
        proxy = cache / f"{mid}_proxy.mp4"
        alt = int(cfg["proxy_altura"])
        # lado maior = alt, mantendo proporção; GOP curto para buscas rápidas na timeline
        escala = (f"scale='if(gt(iw,ih),{alt},-2)':'if(gt(iw,ih),-2,{alt})'")
        args = ["-i", str(origem), "-map", "0:v:0", "-map", "0:a:0?", "-vf", escala + ",fps=30",
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-g", "15",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-ac", "2",
                "-movflags", "+faststart", str(proxy)]
        rodar_ffmpeg(args, tarefa, dur, (0.08, 0.75), "Criando versão leve para edição…")
        resultado["proxy"] = proxy.name

        tarefa.avancar(0.76, "Gerando quadros da timeline…")
        qtd = max(1, min(40, math.ceil(dur / 1.5)))
        tira = cache / f"{mid}_tira.jpg"
        rodar_ffmpeg(["-i", str(proxy), "-vf",
                      f"fps={qtd / max(dur, 0.1):.5f},scale=-2:90,tile={qtd}x1",
                      "-frames:v", "1", "-q:v", "6", str(tira)])
        resultado["tira"] = tira.name
        resultado["tira_qtd"] = qtd
        fonte_onda = proxy
    else:
        tarefa.avancar(0.1, "Convertendo áudio para reprodução…")
        proxy = cache / f"{mid}_proxy.m4a"
        rodar_ffmpeg(["-i", str(origem), "-vn", "-map", "0:a:0", "-c:a", "aac", "-b:a", "128k",
                      "-ac", "2", "-movflags", "+faststart", str(proxy)],
                     tarefa, dur, (0.1, 0.75), "Convertendo áudio para reprodução…")
        resultado["proxy"] = proxy.name
        fonte_onda = proxy

    if info["tem_audio"]:
        tarefa.avancar(0.8, "Desenhando forma de onda…")
        onda = cache / f"{mid}_onda.json"
        gerar_onda(fonte_onda, onda)
        resultado["onda"] = onda.name

    resultado["status"] = "pronto"
    resultado["erro"] = None

    def aplicar(p):
        alvo = projetos.midia(p, mid)
        alvo.update(resultado)
    projetos.alterar(pid, aplicar)
    tarefa.avancar(1.0, "Pronto para editar")
    return {"midia": mid}


def gerar_onda(origem: Path, destino: Path) -> None:
    """Calcula picos de volume (0–100) lendo o áudio em pedaços (pouca memória)."""
    taxa = 4000
    janela = taxa // PICOS_POR_SEG
    proc = subprocess.Popen(
        [config.ffmpeg(), "-hide_banner", "-nostdin", "-v", "error", "-i", str(origem),
         "-vn", "-ac", "1", "-ar", str(taxa), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=config.FLAGS_PROCESSO,
    )
    picos: list[int] = []
    sobra = b""
    while True:
        bloco = proc.stdout.read(janela * 2 * 500)
        if not bloco:
            break
        bloco = sobra + bloco
        util = len(bloco) - (len(bloco) % (janela * 2))
        amostras = array("h")
        amostras.frombytes(bloco[:util])
        sobra = bloco[util:]
        for i in range(0, len(amostras), janela):
            trecho = amostras[i:i + janela]
            pico = max(max(trecho), -min(trecho)) if trecho else 0
            picos.append(pico)
    proc.wait()
    proc.stdout.close()
    maior = max(picos) if picos else 1
    # escala logarítmica suave, melhor para visualizar fala
    norm = []
    for p in picos:
        v = p / 32768
        db = 20 * math.log10(v) if v > 0 else -90
        norm.append(int(max(0, min(100, (db + 60) / 60 * 100))))
    destino.write_text(json.dumps({"por_seg": PICOS_POR_SEG, "picos": norm, "max": maior}),
                       encoding="utf-8")
