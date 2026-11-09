"""Servidor local (somente no seu computador: 127.0.0.1).

Usa apenas a biblioteca padrão do Python — nenhuma dependência extra.
Entrega a interface (pasta ``web``) e uma API JSON usada por ela.
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import traceback
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import VERSAO, analise, config, exportacao, legendas, midia, montagem, projetos, transcricao
from .tarefas import FILA, Tarefa

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("audio/mp4", ".m4a")

# Libera o modelo Whisper da memória quando não há mais nada na fila.
FILA.ao_ficar_ociosa(transcricao.liberar)


class Erro(Exception):
    def __init__(self, status: int, mensagem: str):
        super().__init__(mensagem)
        self.status = status
        self.mensagem = mensagem


ROTAS: list[tuple[str, re.Pattern, callable]] = []


def rota(metodo: str, padrao: str):
    def deco(funcao):
        ROTAS.append((metodo, re.compile("^" + padrao + "$"), funcao))
        return funcao
    return deco


# ===================================================================== API

@rota("GET", "/api/sistema")
def api_sistema(req, _):
    return {"versao": VERSAO, "diagnostico": config.diagnostico(), "config": config.carregar(),
            "dados": str(config.PASTA_DADOS), "seletor_nativo": _tem_tkinter()}


@rota("GET", "/api/config")
def api_config(req, _):
    return config.carregar()


@rota("PUT", "/api/config")
def api_config_salvar(req, _):
    return config.salvar(req.json())


@rota("GET", "/api/projetos")
def api_projetos(req, _):
    return projetos.listar()


@rota("POST", "/api/projetos")
def api_projeto_criar(req, _):
    dados = req.json()
    return projetos.criar(dados.get("nome", ""), dados.get("briefing"))


@rota("GET", r"/api/projetos/(?P<pid>[\w-]+)")
def api_projeto(req, a):
    return _carregar(a["pid"])


@rota("PUT", r"/api/projetos/(?P<pid>[\w-]+)")
def api_projeto_salvar(req, a):
    _carregar(a["pid"])
    p = projetos.salvar_edicao(a["pid"], req.json())
    return {"ok": True, "versao": p["versao"], "atualizado": p["atualizado"]}


@rota("DELETE", r"/api/projetos/(?P<pid>[\w-]+)")
def api_projeto_excluir(req, a):
    _carregar(a["pid"])
    for t in FILA.listar(a["pid"]):
        if t["estado"] in ("na_fila", "executando"):
            raise Erro(409, "Aguarde as tarefas deste projeto terminarem (ou cancele-as) antes de excluir.")
    projetos.excluir(a["pid"])
    return {"ok": True}


@rota("POST", r"/api/projetos/(?P<pid>[\w-]+)/duplicar")
def api_projeto_duplicar(req, a):
    _carregar(a["pid"])
    return projetos.duplicar(a["pid"])


def _registrar_midia(pid: str, nome: str, tipo: str, arquivo: str, externo: bool) -> dict:
    m = {"id": projetos.novo_id("m"), "nome": nome, "tipo": tipo, "arquivo": arquivo,
         "externo": externo, "status": "processando", "erro": None}
    projetos.alterar(pid, lambda p: p["midias"].append(m))
    _agendar_preparo(pid, m)
    return m


def _agendar_preparo(pid: str, m: dict):
    def trabalho(tarefa):
        try:
            return midia.preparar(tarefa, pid, m["id"])
        except Exception as erro:
            msg = str(erro)

            def marcar(p):
                alvo = projetos.midia(p, m["id"])
                alvo["status"], alvo["erro"] = "erro", msg
            projetos.alterar(pid, marcar)
            raise
    FILA.adicionar(Tarefa("importar", f"Importando “{m['nome']}”", pid, trabalho, midia=m["id"]))


@rota("POST", r"/api/projetos/(?P<pid>[\w-]+)/importar")
def api_importar(req, a):
    """Recebe o arquivo enviado pelo navegador e salva uma CÓPIA no projeto."""
    pid = a["pid"]
    _carregar(pid)
    nome = urllib.parse.unquote(req.headers.get("X-Nome", "")).strip()
    nome = Path(nome.replace("\\", "/")).name or "arquivo"
    tipo = req.headers.get("X-Tipo") or midia.tipo_por_extensao(nome)
    if tipo not in ("video", "audio"):
        raise Erro(400, f"O arquivo “{nome}” não parece ser um vídeo ou áudio suportado.")
    tamanho = int(req.headers.get("Content-Length") or 0)
    if tamanho <= 0:
        raise Erro(400, "Arquivo vazio.")
    livre = shutil.disk_usage(projetos.pasta(pid)).free
    if tamanho > livre - 200 * 1024 * 1024:
        raise Erro(507, "Não há espaço suficiente no disco para importar este arquivo.")
    destino_dir = projetos.pasta(pid) / "originais"
    destino_dir.mkdir(parents=True, exist_ok=True)
    seguro = re.sub(r'[\\/:*?"<>|]+', "_", nome)
    destino = destino_dir / f"{projetos.novo_id()}_{seguro}"
    restante = tamanho
    try:
        with open(destino, "wb") as f:
            while restante > 0:
                bloco = req.rfile.read(min(1024 * 1024, restante))
                if not bloco:
                    raise Erro(400, "O envio do arquivo foi interrompido.")
                f.write(bloco)
                restante -= len(bloco)
    except BaseException:
        destino.unlink(missing_ok=True)
        raise
    return _registrar_midia(pid, nome, tipo, f"originais/{destino.name}", externo=False)


@rota("POST", r"/api/projetos/(?P<pid>[\w-]+)/importar-caminhos")
def api_importar_caminhos(req, a):
    """Usa arquivos no lugar onde estão (sem copiar). Eles são apenas lidos."""
    pid = a["pid"]
    _carregar(pid)
    criados, erros = [], []
    for bruto in req.json().get("caminhos", []):
        caminho = Path(str(bruto).strip().strip('"'))
        tipo = midia.tipo_por_extensao(caminho.name)
        if not caminho.is_file():
            erros.append(f"Arquivo não encontrado: {caminho}")
        elif tipo is None:
            erros.append(f"Formato não suportado: {caminho.name}")
        else:
            criados.append(_registrar_midia(pid, caminho.name, tipo, str(caminho.resolve()), externo=True))
    return {"midias": criados, "erros": erros}


@rota("POST", "/api/selecionar-arquivos")
def api_selecionar(req, _):
    """Abre a janela nativa "Abrir arquivo" do Windows (se o tkinter estiver disponível)."""
    if not _tem_tkinter():
        raise Erro(501, "A janela de seleção nativa não está disponível neste Python.")
    codigo = (
        "import tkinter as tk, json; from tkinter import filedialog as fd\n"
        "r=tk.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
        "p=fd.askopenfilenames(title='Escolha vídeos ou áudios', filetypes=["
        "('Vídeos e áudios','*.mp4 *.mov *.m4v *.mkv *.avi *.webm *.mp3 *.wav *.m4a *.aac *.ogg *.opus *.flac'),"
        "('Todos os arquivos','*.*')])\n"
        "print(json.dumps(list(p)))"
    )
    r = subprocess.run([sys.executable, "-c", codigo], capture_output=True, text=True,
                       encoding="utf-8", timeout=600)
    try:
        return {"caminhos": json.loads(r.stdout.strip().splitlines()[-1])}
    except (ValueError, IndexError):
        return {"caminhos": []}


_tk_cache = None


def _tem_tkinter() -> bool:
    global _tk_cache
    if _tk_cache is None:
        try:
            import tkinter  # noqa: F401
            _tk_cache = bool(os.environ.get("DISPLAY")) or config.EH_WINDOWS or sys.platform == "darwin"
        except Exception:  # noqa: BLE001
            _tk_cache = False
    return _tk_cache


@rota("DELETE", r"/api/projetos/(?P<pid>[\w-]+)/midias/(?P<mid>\w+)")
def api_midia_remover(req, a):
    pid, mid = a["pid"], a["mid"]
    p = _carregar(pid)
    m = _midia(p, mid)
    if any(c.get("midia") == mid for c in p["timeline"].get("clipes", [])):
        raise Erro(409, "Este arquivo está sendo usado na timeline. Remova os clipes dele antes.")
    if FILA.pendente("importar", pid, midia=mid) or FILA.pendente("analisar", pid, midia=mid):
        raise Erro(409, "Aguarde o processamento deste arquivo terminar.")

    def aplicar(proj):
        proj["midias"] = [x for x in proj["midias"] if x["id"] != mid]
        proj["sugestoes"] = [s for s in proj.get("sugestoes", []) if s["midia"] != mid]
        proj["timeline"]["legendas"] = [l for l in proj["timeline"].get("legendas", []) if l.get("midia") != mid]
    projetos.alterar(pid, aplicar)
    pasta = projetos.pasta(pid)
    # remove apenas arquivos gerados pelo app e a CÓPIA feita na importação
    for arq in list((pasta / "cache").glob(f"{mid}_*")) + [pasta / "analise" / f"{mid}.json"]:
        arq.unlink(missing_ok=True)
    if not m.get("externo"):
        (pasta / m["arquivo"]).unlink(missing_ok=True)
    return {"ok": True}


@rota("POST", r"/api/projetos/(?P<pid>[\w-]+)/midias/(?P<mid>\w+)/reprocessar")
def api_midia_reprocessar(req, a):
    p = _carregar(a["pid"])
    m = _midia(p, a["mid"])

    def marcar(proj):
        projetos.midia(proj, a["mid"]).update({"status": "processando", "erro": None})
    projetos.alterar(a["pid"], marcar)
    _agendar_preparo(a["pid"], m)
    return {"ok": True}


@rota("POST", r"/api/projetos/(?P<pid>[\w-]+)/analisar")
def api_analisar(req, a):
    pid = a["pid"]
    p = _carregar(pid)
    pedidas = req.json().get("midias") or [m["id"] for m in p["midias"]]
    criadas = []
    for mid in pedidas:
        m = _midia(p, mid)
        if FILA.pendente("analisar", pid, midia=mid):
            continue
        FILA.adicionar(Tarefa(
            "analisar", f"Analisando “{m['nome']}”", pid,
            lambda t, mid=mid: analise.analisar(t, pid, mid), midia=mid))
        criadas.append(mid)
    return {"agendadas": criadas}


@rota("GET", r"/api/projetos/(?P<pid>[\w-]+)/analise/(?P<mid>\w+)")
def api_analise_detalhe(req, a):
    _carregar(a["pid"])
    detalhe = analise.carregar_detalhe(a["pid"], a["mid"])
    if detalhe is None:
        raise Erro(404, "Este arquivo ainda não foi analisado.")
    detalhe.pop("movimento", None)
    return detalhe


@rota("POST", r"/api/projetos/(?P<pid>[\w-]+)/montar")
def api_montar(req, a):
    _carregar(a["pid"])
    try:
        return montagem.montar(a["pid"])
    except ValueError as erro:
        raise Erro(400, str(erro)) from erro


@rota("POST", r"/api/projetos/(?P<pid>[\w-]+)/legendas/gerar")
def api_legendas(req, a):
    _carregar(a["pid"])
    d = req.json()
    return {"legendas": legendas.gerar(a["pid"], int(d.get("max_palavras", 5)))}


@rota("POST", r"/api/projetos/(?P<pid>[\w-]+)/exportar")
def api_exportar(req, a):
    pid = a["pid"]
    p = _carregar(pid)
    d = req.json()
    tipo = "previa" if d.get("tipo") == "previa" else "final"
    if projetos.duracao_timeline(p.get("timeline", {})) <= 0.05:
        raise Erro(400, "A timeline está vazia. Adicione takes antes de exportar.")
    if FILA.pendente("exportar", pid):
        raise Erro(409, "Já existe uma exportação deste projeto em andamento.")
    t = FILA.adicionar(Tarefa(
        "exportar", ("Prévia de " if tipo == "previa" else "Exportando ") + f"“{p['nome']}”", pid,
        lambda tarefa: exportacao.exportar(tarefa, pid, tipo, bool(d.get("legendas", True))),
        modo=tipo))
    return t.como_dict()


@rota("GET", "/api/exportacoes")
def api_exportacoes(req, _):
    saida = []
    for resumo in projetos.listar():
        try:
            p = projetos.carregar(resumo["id"])
        except (KeyError, ValueError):
            continue
        for e in p.get("exportacoes", []):
            e = {**e, "projeto": p["id"], "projeto_nome": p["nome"], "existe": Path(e["arquivo"]).exists()}
            saida.append(e)
    return sorted(saida, key=lambda e: e["criado"], reverse=True)


@rota("DELETE", r"/api/exportacoes/(?P<pid>[\w-]+)/(?P<eid>\w+)")
def api_exportacao_remover(req, a):
    """Remove da lista; apaga o arquivo só se o usuário pediu (apagar_arquivo=1)."""
    p = _carregar(a["pid"])
    e = next((x for x in p.get("exportacoes", []) if x["id"] == a["eid"]), None)
    if not e:
        raise Erro(404, "Exportação não encontrada.")
    if req.query.get("apagar_arquivo") == "1":
        for arq in (Path(e["arquivo"]), Path(e["arquivo"]).with_suffix(".srt")):
            arq.unlink(missing_ok=True)
    projetos.alterar(a["pid"], lambda proj: proj.__setitem__(
        "exportacoes", [x for x in proj.get("exportacoes", []) if x["id"] != a["eid"]]))
    return {"ok": True}


@rota("POST", "/api/abrir-pasta")
def api_abrir_pasta(req, _):
    d = req.json()
    p = _carregar(d.get("projeto", ""))
    alvo = projetos.pasta(p["id"]) / "exportacoes"
    if d.get("exportacao"):
        e = next((x for x in p.get("exportacoes", []) if x["id"] == d["exportacao"]), None)
        if e:
            alvo = Path(e["arquivo"]).parent
    alvo.mkdir(parents=True, exist_ok=True)
    try:
        if config.EH_WINDOWS:
            os.startfile(str(alvo))  # noqa: S606  (abre o Explorador de Arquivos)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(alvo)])
        else:
            subprocess.Popen(["xdg-open", str(alvo)], stderr=subprocess.DEVNULL)
    except OSError as erro:
        raise Erro(500, f"Não consegui abrir a pasta: {erro}") from erro
    return {"ok": True, "pasta": str(alvo)}


@rota("GET", "/api/tarefas")
def api_tarefas(req, _):
    return FILA.listar(req.query.get("projeto"))


@rota("POST", r"/api/tarefas/(?P<tid>\w+)/cancelar")
def api_tarefa_cancelar(req, a):
    t = FILA.obter(a["tid"])
    if not t:
        raise Erro(404, "Tarefa não encontrada.")
    t.cancelar()
    return t.como_dict()


def _carregar(pid: str) -> dict:
    try:
        return projetos.carregar(pid)
    except KeyError as erro:
        raise Erro(404, "Projeto não encontrado. Ele pode ter sido excluído.") from erro


def _midia(p: dict, mid: str) -> dict:
    try:
        return projetos.midia(p, mid)
    except KeyError as erro:
        raise Erro(404, "Arquivo não encontrado neste projeto.") from erro


# ===================================================================== HTTP

class Manipulador(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MeuEstudioUGCLite/" + VERSAO

    def log_message(self, formato, *args):  # silencioso, exceto erros
        if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")) and "/arquivo/" not in self.path:
            sys.stderr.write("[servidor] " + (formato % args) + "\n")

    # utilidades de requisição
    def json(self) -> dict:
        tam = int(self.headers.get("Content-Length") or 0)
        if tam <= 0:
            return {}
        try:
            dados = json.loads(self.rfile.read(tam).decode("utf-8"))
        except ValueError as erro:
            raise Erro(400, "Dados inválidos enviados pela interface.") from erro
        return dados if isinstance(dados, dict) else {}

    def _responder_json(self, dados, status=200):
        corpo = json.dumps(dados, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(corpo)

    def _tratar(self, metodo: str):
        url = urllib.parse.urlsplit(self.path)
        self.query = dict(urllib.parse.parse_qsl(url.query))
        caminho = urllib.parse.unquote(url.path)
        try:
            if caminho.startswith("/api/"):
                for m, padrao, funcao in ROTAS:
                    if m == metodo:
                        achou = padrao.match(caminho)
                        if achou:
                            return self._responder_json(funcao(self, achou.groupdict()))
                raise Erro(404, "Endereço não encontrado.")
            if metodo != "GET" and metodo != "HEAD":
                raise Erro(405, "Método não permitido.")
            if caminho.startswith("/arquivo/"):
                return self._arquivo_midia(caminho)
            if caminho.startswith("/exportado/"):
                return self._arquivo_exportado(caminho)
            return self._estatico(caminho)
        except Erro as erro:
            self._descartar_corpo()
            self._responder_json({"erro": erro.mensagem}, erro.status)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as erro:  # noqa: BLE001
            traceback.print_exc()
            self._descartar_corpo()
            try:
                self._responder_json({"erro": f"Erro inesperado no aplicativo: {erro}"}, 500)
            except OSError:
                pass

    def _descartar_corpo(self):
        # evita conexão "presa" quando um upload é recusado
        self.close_connection = True

    def do_GET(self):
        self._tratar("GET")

    def do_HEAD(self):
        self._tratar("HEAD")

    def do_POST(self):
        self._tratar("POST")

    def do_PUT(self):
        self._tratar("PUT")

    def do_DELETE(self):
        self._tratar("DELETE")

    # arquivos
    def _estatico(self, caminho: str):
        if caminho in ("", "/"):
            caminho = "/index.html"
        alvo = (config.PASTA_WEB / caminho.lstrip("/")).resolve()
        if config.PASTA_WEB.resolve() not in alvo.parents or not alvo.is_file():
            alvo = config.PASTA_WEB / "index.html"  # rotas da interface (#/…)
        self._enviar_arquivo(alvo, cache=False)

    def _arquivo_midia(self, caminho: str):
        partes = caminho.strip("/").split("/")
        if len(partes) != 4:
            raise Erro(404, "Arquivo não encontrado.")
        _, pid, mid, tipo = partes
        p = _carregar(pid)
        m = _midia(p, mid)
        chave = {"miniatura": "miniatura", "proxy": "proxy", "tira": "tira", "onda": "onda"}.get(tipo)
        if not chave or not m.get(chave):
            raise Erro(404, "Arquivo ainda não gerado.")
        self._enviar_arquivo(projetos.pasta(pid) / "cache" / m[chave], cache=True)

    def _arquivo_exportado(self, caminho: str):
        partes = caminho.strip("/").split("/")
        if len(partes) != 3:
            raise Erro(404, "Arquivo não encontrado.")
        p = _carregar(partes[1])
        e = next((x for x in p.get("exportacoes", []) if x["id"] == partes[2]), None)
        if not e or not Path(e["arquivo"]).is_file():
            raise Erro(404, "O arquivo exportado não foi encontrado (pode ter sido movido).")
        self._enviar_arquivo(Path(e["arquivo"]), cache=False,
                             baixar=e["nome"] if self.query.get("baixar") else None)

    def _enviar_arquivo(self, arq: Path, cache: bool, baixar: str | None = None):
        tamanho = arq.stat().st_size
        tipo = mimetypes.guess_type(arq.name)[0] or "application/octet-stream"
        inicio, fim = 0, tamanho - 1
        faixa = self.headers.get("Range")
        status = 200
        if faixa:
            m = re.match(r"bytes=(\d*)-(\d*)", faixa)
            if m:
                if m.group(1):
                    inicio = int(m.group(1))
                    if m.group(2):
                        fim = min(int(m.group(2)), tamanho - 1)
                elif m.group(2):
                    inicio = max(0, tamanho - int(m.group(2)))
                if inicio > fim:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{tamanho}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        self.send_response(status)
        self.send_header("Content-Type", tipo)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(fim - inicio + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {inicio}-{fim}/{tamanho}")
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-cache")
        if baixar:
            self.send_header("Content-Disposition",
                             "attachment; filename*=UTF-8''" + urllib.parse.quote(baixar))
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(arq, "rb") as f:
            f.seek(inicio)
            restante = fim - inicio + 1
            while restante > 0:
                bloco = f.read(min(256 * 1024, restante))
                if not bloco:
                    break
                self.wfile.write(bloco)
                restante -= len(bloco)


def criar_servidor(porta: int) -> ThreadingHTTPServer:
    config.PASTA_PROJETOS.mkdir(parents=True, exist_ok=True)
    servidor = ThreadingHTTPServer(("127.0.0.1", porta), Manipulador)
    servidor.daemon_threads = True
    return servidor
