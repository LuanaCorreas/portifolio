"""Meu Estúdio UGC Lite — inicia o servidor local e abre o aplicativo no navegador.

Uso normal: dê dois cliques em "Iniciar Meu Estudio UGC Lite.bat".
(Este arquivo só precisa ser executado diretamente durante o desenvolvimento.)
"""
from __future__ import annotations

import argparse
import socket
import sys
import threading
import webbrowser

from estudio import VERSAO, config
from estudio.servidor import criar_servidor


def porta_livre(preferida: int) -> int:
    for porta in range(preferida, preferida + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", porta)) != 0:
                return porta
    raise SystemExit("Nenhuma porta livre encontrada entre %d e %d." % (preferida, preferida + 19))


def main() -> None:
    cfg = config.carregar()
    parser = argparse.ArgumentParser(description="Meu Estúdio UGC Lite")
    parser.add_argument("--porta", type=int, default=cfg["porta"])
    parser.add_argument("--sem-navegador", action="store_true")
    args = parser.parse_args()

    porta = porta_livre(args.porta)
    servidor = criar_servidor(porta)
    endereco = f"http://127.0.0.1:{porta}/"
    print("=" * 60)
    print(f"  Meu Estúdio UGC Lite {VERSAO}")
    print(f"  Aberto em: {endereco}")
    print("  Mantenha esta janela aberta enquanto usa o aplicativo.")
    print("  Para encerrar, feche esta janela.")
    print("=" * 60)
    if cfg["abrir_navegador"] and not args.sem_navegador:
        threading.Timer(0.8, lambda: webbrowser.open(endereco)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        servidor.server_close()


if __name__ == "__main__":
    if sys.version_info < (3, 10):
        raise SystemExit("O Meu Estúdio UGC Lite precisa do Python 3.10 ou mais novo.")
    main()
