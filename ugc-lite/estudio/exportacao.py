"""EXPORTAR VÍDEO — monta o comando do FFmpeg a partir da timeline do projeto.

Padrão: MP4, H.264, 1080×1920 (vertical 9:16), 30 fps, áudio AAC.
Prévia: mesma montagem em resolução menor e codificação mais rápida.

Os cortes são lidos diretamente dos ARQUIVOS ORIGINAIS (qualidade máxima),
sem nunca alterá-los. Legendas e textos são gravados num arquivo .ass
temporário e "queimados" na imagem pelo FFmpeg (libass).
"""
from __future__ import annotations

import re
import time
from pathlib import Path

from . import config, projetos
from .tarefas import ErroAmigavel, Tarefa, rodar_ffmpeg

FPS_PADRAO = 30


# ------------------------------------------------------------ timeline

def clipes(tl: dict, faixa: str) -> list[dict]:
    lista = [c for c in tl.get("clipes", []) if c.get("faixa") == faixa
             and float(c["fim"]) - float(c["ini"]) > 0.02]
    return sorted(lista, key=lambda c: float(c["pos"]))


def dur(c: dict) -> float:
    return float(c["fim"]) - float(c["ini"])


def tl_de_fonte(tl: dict, midia: str, t: float):
    """Converte um instante do arquivo de origem para o tempo da timeline."""
    for c in sorted(tl.get("clipes", []), key=lambda c: float(c["pos"])):
        if c.get("midia") == midia and float(c["ini"]) - 1e-3 <= t < float(c["fim"]):
            return float(c["pos"]) + t - float(c["ini"]), float(c["pos"]) + dur(c)
    return None


def resolver_legendas(tl: dict) -> list[dict]:
    saida = []
    for leg in tl.get("legendas", []):
        texto = (leg.get("texto") or "").strip()
        if not texto:
            continue
        if leg.get("midia"):
            r = tl_de_fonte(tl, leg["midia"], float(leg["t"]))
            if not r:
                continue  # trecho cortado da timeline
            ini, limite = r
            fim = min(ini + float(leg["dur"]), limite)
        else:
            ini = float(leg.get("pos", 0))
            fim = ini + float(leg.get("dur", 0))
        if fim - ini > 0.05:
            saida.append({"ini": ini, "fim": fim, "texto": texto})
    saida.sort(key=lambda x: x["ini"])
    return saida


def duracao_total(tl: dict) -> float:
    return projetos.duracao_timeline(tl)


# ------------------------------------------------------------ legendas ASS / SRT

def _cor_ass(hexcor: str, alfa: int = 0) -> str:
    h = (hexcor or "#FFFFFF").lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alfa:02X}{b}{g}{r}".upper()


def _tempo_ass(s: float) -> str:
    s = max(0.0, s)
    cs = int(round(s * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _tempo_srt(s: float) -> str:
    ms = int(round(max(0.0, s) * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def _limpar_ass(texto: str) -> str:
    texto = texto.replace("\\", "/").replace("{", "(").replace("}", ")")
    return texto.replace("\r", "").replace("\n", "\\N")


def _estilo_ass(nome: str, e: dict, alinhamento: int, margem_v: int) -> str:
    fundo = bool(e.get("fundo"))
    borda = 3 if fundo else 1
    contorno = _cor_ass(e.get("cor_fundo", "#000000"), 0x30) if fundo else _cor_ass(e.get("contorno", "#000000"))
    espessura = 14 if fundo else int(e.get("espessura", 4))
    return (f"Style: {nome},{e.get('fonte', 'Arial')},{int(e.get('tamanho', 64))},"
            f"{_cor_ass(e.get('cor', '#FFFFFF'))},{_cor_ass(e.get('cor', '#FFFFFF'))},"
            f"{contorno},{_cor_ass('#000000', 0x80)},{-1 if e.get('negrito', True) else 0},0,0,0,"
            f"100,100,0,0,{borda},{espessura},0,{alinhamento},60,60,{int(margem_v)},1")


def gerar_ass(projeto: dict, incluir_legendas: bool = True) -> str | None:
    tl = projeto.get("timeline", {})
    est = {**projetos.estilo_legenda_padrao(), **(projeto.get("legenda_estilo") or {})}
    alinh = {"baixo": 2, "meio": 5, "topo": 8}.get(est.get("posicao"), 2)
    estilos = [_estilo_ass("Legenda", est, alinh, int(est.get("margem", 260)))]
    eventos = []
    if incluir_legendas and est.get("ativar", True):
        for leg in resolver_legendas(tl):
            eventos.append(f"Dialogue: 0,{_tempo_ass(leg['ini'])},{_tempo_ass(leg['fim'])},Legenda,,0,0,0,,"
                           f"{_limpar_ass(leg['texto'])}")
    for i, t in enumerate(tl.get("textos", [])):
        texto = (t.get("texto") or "").strip()
        if not texto or float(t.get("dur", 0)) <= 0:
            continue
        e = {**projetos.estilo_legenda_padrao(), "tamanho": 80, **(t.get("estilo") or {})}
        nome = f"Texto{i}"
        estilos.append(_estilo_ass(nome, e, 5, 0))
        x = int(float(e.get("x", 0.5)) * 1080)
        y = int(float(e.get("y", 0.2)) * 1920)
        ini = float(t["pos"])
        eventos.append(f"Dialogue: 1,{_tempo_ass(ini)},{_tempo_ass(ini + float(t['dur']))},{nome},,0,0,0,,"
                       f"{{\\an5\\pos({x},{y})}}{_limpar_ass(texto)}")
    if not eventos:
        return None
    return "\n".join([
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920",
        "ScaledBorderAndShadow: yes", "WrapStyle: 0", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        *estilos, "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        *eventos, "",
    ])


def gerar_srt(projeto: dict) -> str:
    linhas = []
    for i, leg in enumerate(resolver_legendas(projeto.get("timeline", {})), 1):
        linhas += [str(i), f"{_tempo_srt(leg['ini'])} --> {_tempo_srt(leg['fim'])}", leg["texto"], ""]
    return "\n".join(linhas)


# ------------------------------------------------------------ comando FFmpeg

def montar_comando(projeto: dict, saida: str, *, largura: int, altura: int, fps: int,
                   codec_video: list[str], audio_kbps: int, enquadramento: str,
                   ass: str | None, normalizar: bool = False) -> tuple[list[str], float]:
    pid = projeto["id"]
    tl = projeto.get("timeline", {})
    midias = {m["id"]: m for m in projeto.get("midias", [])}
    total = duracao_total(tl)
    if total <= 0.05:
        raise ErroAmigavel("A timeline está vazia. Adicione takes antes de exportar.")

    entradas: list[str] = []
    n_entradas = 0
    filtros: list[str] = []
    rotulos_v: list[str] = []
    audios: list[str] = []
    W, H = largura, altura
    if enquadramento == "ajustar":
        escala = (f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
                  f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black")
    else:
        escala = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"

    def entrada(c: dict, so: str) -> int:
        # Cada arquivo é aberto separadamente para vídeo (-an) e para áudio (-vn).
        # Isso evita travamentos do FFmpeg quando o mesmo arquivo alimenta a
        # concatenação de vídeo e a mixagem de áudio em momentos diferentes.
        nonlocal n_entradas
        m = midias.get(c["midia"])
        if not m:
            raise ErroAmigavel("Um clipe da timeline aponta para uma mídia que não existe mais.")
        caminho = projetos.caminho_midia(pid, m)
        if not caminho.exists():
            raise ErroAmigavel(f"O arquivo original “{m['nome']}” não foi encontrado em {caminho}.")
        entradas.extend(["-an" if so == "v" else "-vn", "-ss", f"{float(c['ini']):.3f}",
                         "-t", f"{dur(c):.3f}", "-i", str(caminho)])
        n_entradas += 1
        return n_entradas - 1

    def lacuna(d: float):
        rot = f"g{len(rotulos_v)}"
        filtros.append(f"color=c=black:s={W}x{H}:r={fps}:d={d:.3f},format=yuv420p,setsar=1[{rot}]")
        rotulos_v.append(f"[{rot}]")

    def adicionar_audio(c: dict, inicio: float):
        m = midias[c["midia"]]
        vol = float(c.get("volume", 1.0))
        if c.get("mudo") or vol <= 0 or not m.get("tem_audio"):
            return
        idx = entrada(c, "a")
        rot = f"a{len(audios)}"
        atraso = int(round(inicio * 1000))
        filtros.append(
            f"[{idx}:a:0]aresample=48000,aformat=channel_layouts=stereo,"
            f"atrim=0:{dur(c):.3f},asetpts=PTS-STARTPTS,volume={vol:.3f},"
            f"adelay={atraso}|{atraso}[{rot}]")
        audios.append(f"[{rot}]")

    t = 0.0
    for c in clipes(tl, "V"):
        ini = max(float(c["pos"]), t)
        corte_ini = ini - float(c["pos"])  # sobreposição: corta o começo
        d = dur(c) - corte_ini
        if d <= 0.02:
            continue
        if ini - t > 0.01:
            lacuna(ini - t)
        clip = {**c, "ini": float(c["ini"]) + corte_ini}
        idx = entrada(clip, "v")
        rot = f"v{len(rotulos_v)}"
        filtros.append(
            f"[{idx}:v:0]{escala},setsar=1,fps={fps},format=yuv420p,"
            f"tpad=stop_mode=clone:stop_duration={d:.3f},trim=duration={d:.3f},"
            f"setpts=PTS-STARTPTS[{rot}]")
        rotulos_v.append(f"[{rot}]")
        adicionar_audio(clip, ini)
        t = ini + d
    if total - t > 0.01:
        lacuna(total - t)

    for c in clipes(tl, "N"):
        adicionar_audio(c, max(0.0, float(c["pos"])))

    filtros.append(f"{''.join(rotulos_v)}concat=n={len(rotulos_v)}:v=1:a=0[vc]")
    if ass:
        filtros.append("[vc]ass=filename=legendas.ass[vout]")
        mapa_v = "[vout]"
    else:
        mapa_v = "[vc]"
    # Volume padrão de Reels/TikTok/Shorts: -14 LUFS, picos até -1,5 dB.
    volume = ",loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000" if normalizar else ""
    if audios:
        filtros.append(f"{''.join(audios)}amix=inputs={len(audios)}:normalize=0:"
                       f"dropout_transition=0:duration=longest{volume},apad,atrim=0:{total:.3f}[aout]")
    else:
        filtros.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{total:.3f}[aout]")

    cmd = entradas + [
        "-filter_complex", ";".join(filtros), "-map", mapa_v, "-map", "[aout]",
        *codec_video, "-r", str(fps), "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", f"{audio_kbps}k", "-ar", "48000",
        "-t", f"{total:.3f}", "-movflags", "+faststart", saida,
    ]
    return cmd, total


def _nome_arquivo(nome: str) -> str:
    base = re.sub(r'[\\/:*?"<>|]+', "", nome).strip() or "video"
    return base[:60]


def exportar(tarefa: Tarefa, pid: str, tipo: str = "final", legendas: bool = True) -> dict:
    cfg = config.carregar()
    projeto = projetos.carregar(pid)
    previa = tipo == "previa"
    largura = int(cfg["previa_largura"] if previa else cfg["export_largura"])
    altura = int(cfg["previa_altura"] if previa else cfg["export_altura"])
    fps = int(cfg["export_fps"]) or FPS_PADRAO

    pasta_proj = projetos.pasta(pid) / "exportacoes"
    pasta_saida = Path(cfg["export_pasta"]) if cfg["export_pasta"] and not previa else pasta_proj
    pasta_saida.mkdir(parents=True, exist_ok=True)
    pasta_proj.mkdir(parents=True, exist_ok=True)
    carimbo = time.strftime("%Y-%m-%d_%H%M%S")
    nome = f"{_nome_arquivo(projeto['nome'])}_{'PREVIA_' if previa else ''}{carimbo}.mp4"
    saida = pasta_saida / nome

    tarefa.avancar(0.01, "Preparando legendas e textos…")
    ass = gerar_ass(projeto, legendas)
    if ass:
        (pasta_proj / "legendas.ass").write_text(ass, encoding="utf-8")
    srt = gerar_srt(projeto)

    if previa:
        codecs = [["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"]]
    else:
        x264 = ["-c:v", "libx264", "-preset", str(cfg["export_preset"]), "-crf",
                str(int(cfg["export_crf"])), "-profile:v", "high"]
        codecs = [x264]
        if cfg["export_quicksync"]:
            codecs.insert(0, ["-c:v", "h264_qsv", "-global_quality", "22", "-preset", "veryfast"])

    ultimo_erro = None
    for i, codec in enumerate(codecs):
        cmd, total = montar_comando(
            projeto, str(saida), largura=largura, altura=altura, fps=fps, codec_video=codec,
            audio_kbps=int(cfg["export_audio_kbps"]), enquadramento=cfg["export_enquadramento"],
            ass="legendas.ass" if ass else None, normalizar=bool(cfg["export_normalizar"]))
        msg = "Gerando prévia…" if previa else "Exportando vídeo…"
        if i > 0:
            msg = "Quick Sync indisponível — exportando pela CPU…"
        try:
            rodar_ffmpeg(cmd, tarefa, total, (0.02, 0.99), msg, cwd=str(pasta_proj))
            ultimo_erro = None
            break
        except ErroAmigavel as erro:
            ultimo_erro = erro
            try:
                saida.unlink()
            except OSError:
                pass
    if ultimo_erro:
        raise ultimo_erro

    if srt.strip():
        saida.with_suffix(".srt").write_text(srt, encoding="utf-8")
    registro = {
        "id": projetos.novo_id("e"), "arquivo": str(saida), "nome": saida.name, "tipo": tipo,
        "criado": time.time(), "duracao": round(total, 2), "largura": largura, "altura": altura,
        "fps": fps, "tamanho": saida.stat().st_size, "legendas": bool(ass),
    }
    projetos.alterar(pid, lambda p: p.setdefault("exportacoes", []).append(registro))
    tarefa.avancar(1.0, "Vídeo exportado com sucesso!" if not previa else "Prévia pronta!")
    return registro
