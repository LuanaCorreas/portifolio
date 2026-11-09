"""Testes do backend.  Rodar a partir da pasta ugc-lite:

    python -m unittest discover -s testes -v

Usam uma pasta de dados temporária e um Faster-Whisper SIMULADO (as falas são
definidas aqui), para testar as heurísticas sem baixar o modelo. Os testes de
integração com FFmpeg são pulados se o FFmpeg não estiver instalado.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))
TMP = Path(tempfile.mkdtemp(prefix="ugc_teste_"))
os.environ["UGC_LITE_DADOS"] = str(TMP / "dados")

from estudio import analise, config, exportacao, legendas, montagem, projetos  # noqa: E402
from estudio.tarefas import FILA, Tarefa  # noqa: E402

TEM_FFMPEG = shutil.which("ffmpeg") is not None


def palavras(texto: str, ini: float, passo: float = 0.35, conf: float = 0.9):
    saida, t = [], ini
    for p in texto.split():
        saida.append({"ini": round(t, 2), "fim": round(t + passo - 0.05, 2), "p": p, "conf": conf})
        t += passo
    return saida


def segmento(texto: str, ini: float, **kw):
    ws = palavras(texto, ini, **kw)
    return {"ini": ws[0]["ini"], "fim": ws[-1]["fim"], "texto": texto, "conf": -0.3, "palavras": ws}


# ---------------------------------------------------------------- Whisper simulado
class _Palavra:
    def __init__(self, w):
        self.start, self.end, self.word, self.probability = w["ini"], w["fim"], " " + w["p"], w["conf"]


class _Seg:
    def __init__(self, s):
        self.start, self.end, self.text = s["ini"], s["fim"], " " + s["texto"]
        self.avg_logprob, self.no_speech_prob = -0.25, 0.01
        self.words = [_Palavra(w) for w in s["palavras"]]


FALAS: dict[str, list] = {}


class ModeloFalso:
    def __init__(self, nome, device, compute_type, cpu_threads, num_workers):
        assert device == "cpu" and compute_type == "int8", "deve usar CPU int8"

    def transcribe(self, caminho, language, **kw):
        assert language == "pt"
        return iter([_Seg(s) for s in FALAS[ATUAL[0]]]), types.SimpleNamespace(language="pt")


ATUAL = [None]
sys.modules["faster_whisper"] = types.SimpleNamespace(WhisperModel=ModeloFalso, __version__="simulado")


class TestHeuristicas(unittest.TestCase):
    def test_repeticao_e_erro(self):
        segs = [
            segmento("esse produto é", 0.5),
            segmento("esse produto é incrível para a pele", 2.0),
            segmento("peraí vou de novo", 5.5),
            segmento("a textura é muito muito leve", 8.0),
        ]
        frases = analise.montar_frases(segs)
        sugs = analise.sugestoes_de_fala("m1", frases)
        tipos = [s["tipo"] for s in sugs]
        self.assertIn("repeticao", tipos)
        rep = next(s for s in sugs if s["tipo"] == "repeticao")
        self.assertLess(rep["fim"], 2.0, "deve cortar só a primeira tentativa")
        self.assertIn("erro", tipos)
        self.assertIn("gaguejo", tipos)
        self.assertTrue(all(s["status"] == "pendente" for s in sugs), "nada é aprovado sozinho")

    def test_pausa_com_movimento_vira_demonstracao(self):
        cfg = config.carregar()
        fala = [[0.5, 3.0], [7.0, 9.0]]
        pausas = [[3.0, 7.0]]
        parado = analise.sugestoes_de_audio("m", 10, pausas, [], [[t / 4, 0.0] for t in range(40)], fala, cfg, True)
        self.assertEqual(sorted(s["tipo"] for s in parado if s["ini"] > 2), ["final_parado", "pausa"])
        movimento = [[t / 4, 0.05 if 3 <= t / 4 <= 7 else 0.0] for t in range(40)]
        demo = analise.sugestoes_de_audio("m", 10, pausas, [], movimento, fala, cfg, True)
        d = [s for s in demo if 2.9 <= s["ini"] <= 3.1]
        self.assertEqual(d[0]["tipo"], "demonstracao")
        self.assertEqual(d[0]["acao"], "manter")


def _criar_midia(pid, mid, nome, dur, tipo="video"):
    def aplicar(p):
        p["midias"].append({"id": mid, "nome": nome, "tipo": tipo, "status": "pronto", "duracao": dur,
                            "tem_audio": True, "arquivo": "x", "externo": False})
    projetos.alterar(pid, aplicar)


class TestMontagemELegendas(unittest.TestCase):
    def setUp(self):
        self.p = projetos.criar("Teste Montagem", {"produto": "Sérum Glow", "beneficios": "hidratação, pele macia", "cta": "link na bio"})
        pid = self.p["id"]
        takes = {
            "mA": [segmento("você sabia que existe um segredo para a pele brilhar?", 0.3)],
            "mB": [segmento("esse é o sérum glow que eu recebi", 0.2)],
            "mC": [segmento("eu aplico duas gotas e espalho no rosto", 0.2)],
            "mD": [segmento("a pele fica macia e hidratada eu amei", 0.2)],
            "mE": [segmento("corre e garante o seu no link na bio", 0.2)],
        }
        for mid, segs in takes.items():
            _criar_midia(pid, mid, mid + ".mp4", 6)
            frases = analise.montar_frases(segs)
            config.gravar_json(projetos.pasta(pid) / "analise" / f"{mid}.json",
                               {"frases": frases, "movimento": [], "transcricao": {"segmentos": segs}})

            def aplicar(p, mid=mid, frases=frases):
                projetos.midia(p, mid)["analise"] = {"nota": 80, "texto": " ".join(f["texto"] for f in frases), "melhor": True}
            projetos.alterar(pid, aplicar)
        _criar_midia(pid, "mX", "close.mp4", 4)  # take sem fala (demonstração)

    def test_monta_seis_etapas_sem_inventar(self):
        r = montagem.montar(self.p["id"])
        mapa = {e["chave"]: [i["midia"] for i in e["itens"]] for e in r["etapas"]}
        self.assertEqual(mapa["gancho"], ["mA"])
        self.assertEqual(mapa["apresentacao"], ["mB"])
        self.assertIn("mC", mapa["aplicacao"])
        self.assertIn("mD", mapa["beneficios"])
        self.assertEqual(mapa["cta"], ["mE"])
        todos_textos = {i["texto"] for e in r["etapas"] for i in e["itens"]}
        for txt in todos_textos:  # só textos que existem nas transcrições
            self.assertTrue(txt == "" or any(txt in s for s in [
                "você sabia que existe um segredo para a pele brilhar?", "esse é o sérum glow que eu recebi",
                "eu aplico duas gotas e espalho no rosto", "a pele fica macia e hidratada eu amei",
                "corre e garante o seu no link na bio"]))
        self.assertTrue(all(i["status"] == "pendente" for e in r["etapas"] for i in e["itens"]))

    def test_legendas_ancoradas(self):
        pid = self.p["id"]
        projetos.salvar_edicao(pid, {"timeline": {"clipes": [
            {"id": "c1", "faixa": "V", "midia": "mB", "ini": 0, "fim": 6, "pos": 10, "volume": 1}], "textos": [], "legendas": []}})
        itens = legendas.gerar(pid, max_palavras=3)
        self.assertTrue(all(len(i["texto"].split()) <= 3 for i in itens))
        self.assertTrue(all(i["midia"] == "mB" for i in itens))
        p = projetos.carregar(pid)
        p["timeline"]["legendas"] = itens
        res = exportacao.resolver_legendas(p["timeline"])
        self.assertAlmostEqual(res[0]["ini"], 10 + itens[0]["t"], places=3)
        ass = exportacao.gerar_ass(p)
        self.assertIn("PlayResX: 1080", ass)
        self.assertIn("Dialogue:", ass)
        srt = exportacao.gerar_srt(p)
        self.assertTrue(srt.startswith("1\n00:00:10,"))


@unittest.skipUnless(TEM_FFMPEG, "FFmpeg não instalado")
class TestIntegracaoFFmpeg(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pasta = TMP / "midia"
        cls.pasta.mkdir(exist_ok=True)
        # take vertical com fala simulada, uma pausa de 2,5s e retomada
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x884422:s=360x640:r=30:d=8",
                        "-f", "lavfi", "-i", "sine=f=300:d=8", "-af", "volume='if(between(t,2,4.5),0,1)':eval=frame",
                        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(cls.pasta / "take.mp4")], check=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:d=4", str(cls.pasta / "narr.mp3")], check=True)

    def esperar(self, tarefa, limite=90):
        fim = time.time() + limite
        while tarefa.estado in ("na_fila", "executando") and time.time() < fim:
            time.sleep(0.2)
        self.assertEqual(tarefa.estado, "concluida", tarefa.erro)

    def test_fluxo_completo(self):
        from estudio import midia
        p = projetos.criar("Integração")
        pid = p["id"]
        original = self.pasta / "take.mp4"
        hash_antes = original.read_bytes()
        for nome, tipo in (("take.mp4", "video"), ("narr.mp3", "audio")):
            m = {"id": projetos.novo_id("m"), "nome": nome, "tipo": tipo, "arquivo": str(self.pasta / nome),
                 "externo": True, "status": "processando"}
            projetos.alterar(pid, lambda pr, m=m: pr["midias"].append(m))
            t = FILA.adicionar(Tarefa("importar", nome, pid, lambda tf, mid=m["id"]: midia.preparar(tf, pid, mid)))
            self.esperar(t)
        p = projetos.carregar(pid)
        take, narr = p["midias"]
        self.assertEqual((take["largura"], take["altura"], take["orientacao"]), (360, 640, "vertical"))
        self.assertTrue((projetos.pasta(pid) / "cache" / take["proxy"]).exists())

        FALAS["x"] = [segmento("oi gente olha esse produto", 0.2), segmento("é muito bom eu recomendo", 4.6)]
        ATUAL[0] = "x"
        t = FILA.adicionar(Tarefa("analisar", "a", pid, lambda tf: analise.analisar(tf, pid, take["id"])))
        self.esperar(t)
        p = projetos.carregar(pid)
        tipos = [s["tipo"] for s in p["sugestoes"]]
        self.assertIn("pausa", tipos)
        self.assertIn("oi gente", p["midias"][0]["analise"]["texto"])

        projetos.salvar_edicao(pid, {"timeline": {"clipes": [
            {"id": "c1", "faixa": "V", "midia": take["id"], "ini": 0, "fim": 2.2, "pos": 0, "volume": 1},
            {"id": "c2", "faixa": "V", "midia": take["id"], "ini": 4.3, "fim": 8, "pos": 2.2, "volume": 1},
            {"id": "n1", "faixa": "N", "midia": narr["id"], "ini": 0, "fim": 4, "pos": 1, "volume": 0.8}],
            "textos": [{"id": "t1", "texto": "Link na bio", "pos": 0, "dur": 2, "estilo": {}}],
            "legendas": [{"id": "l1", "texto": "olha esse produto", "midia": take["id"], "t": 1.0, "dur": 1.2}]}})
        for tipo, (w, h) in (("previa", (540, 960)), ("final", (1080, 1920))):
            t = FILA.adicionar(Tarefa("exportar", tipo, pid, lambda tf, tipo=tipo: exportacao.exportar(tf, pid, tipo)))
            self.esperar(t, 180)
            saida = t.resultado["arquivo"]
            info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams",
                                              "-show_format", saida], capture_output=True, text=True).stdout)
            v = next(s for s in info["streams"] if s["codec_type"] == "video")
            a = next(s for s in info["streams"] if s["codec_type"] == "audio")
            self.assertEqual((v["codec_name"], v["width"], v["height"], v["r_frame_rate"]), ("h264", w, h, "30/1"))
            self.assertEqual(a["codec_name"], "aac")
            self.assertAlmostEqual(float(info["format"]["duration"]), 5.9, delta=0.15)
        self.assertEqual(original.read_bytes(), hash_antes, "o arquivo original não pode mudar")


@unittest.skipUnless(TEM_FFMPEG, "FFmpeg não instalado")
class TestServidor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from estudio.servidor import criar_servidor
        cls.srv = criar_servidor(0)
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def req(self, metodo, caminho, dados=None, corpo=None, cab=None):
        if dados is not None:
            corpo = json.dumps(dados).encode()
        r = urllib.request.Request(self.url + caminho, data=corpo, method=metodo, headers=cab or {})
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, json.loads(resp.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def test_api_basica(self):
        st, sis = self.req("GET", "/api/sistema")
        self.assertEqual(st, 200)
        self.assertTrue(sis["diagnostico"]["ffmpeg"]["ok"])
        st, p = self.req("POST", "/api/projetos", {"nome": "API"})
        self.assertEqual(st, 200)
        st, erro = self.req("POST", f"/api/projetos/{p['id']}/importar", corpo=b"abc", cab={"X-Nome": "nota.txt"})
        self.assertEqual(st, 400)
        self.assertIn("vídeo ou áudio", erro["erro"])
        st, erro = self.req("POST", f"/api/projetos/{p['id']}/exportar", {"tipo": "final"})
        self.assertEqual(st, 400)
        self.assertIn("vazia", erro["erro"])
        st, _ = self.req("GET", "/api/projetos/nao-existe-123")
        self.assertEqual(st, 404)
        with urllib.request.urlopen(self.url + "/") as r:
            self.assertIn(b"Meu Est", r.read())


if __name__ == "__main__":
    unittest.main()
