# Meu Estúdio UGC Lite

Aplicativo de edição de vídeos UGC que roda **no seu computador**, abre no
navegador e funciona sem serviços pagos na nuvem. Toda a edição acontece dentro
do aplicativo: importar takes, analisar com IA, aprovar cortes, montar a
sequência, sincronizar narração, legendar e exportar.

> O PowerShell/terminal só é necessário para desenvolvimento e manutenção.

---

## Como abrir

1. Dê **dois cliques** em `Iniciar Meu Estudio UGC Lite.bat`.
2. O navegador abre sozinho em `http://127.0.0.1:8765/`.
3. Deixe a janela preta aberta enquanto usa o app. Para encerrar, feche-a.

Dica: clique com o botão direito no `.bat` → **Enviar para → Área de trabalho
(criar atalho)** para ter um ícone na área de trabalho.

### O que precisa estar instalado (você já tem)

| Ferramenta | Uso |
|---|---|
| Python 3.11 | roda o aplicativo (só biblioteca padrão — **nenhuma dependência nova**) |
| FFmpeg / FFprobe | importação, análise de áudio/imagem e exportação |
| Faster-Whisper 1.2.1 | transcrição em português (modelo `tiny`, CPU, `int8`) |

Na primeira transcrição o modelo `tiny` (~75 MB) é baixado automaticamente, se
ainda não estiver no computador. Depois disso funciona sem internet. Se o
FFmpeg não for encontrado, informe o caminho em **Configurações**.

---

## Fluxo de uso

1. **Novo projeto** — nome e briefing (produto, marca, benefícios, chamada para ação).
2. **Mídia** — arraste vários takes e narrações de uma vez (ou “Usar sem copiar”
   para não duplicar arquivos grandes). Veja miniatura, duração, resolução e
   formato; clique na miniatura para assistir.
3. **Análise IA** — transcrição, pausas longas, repetições, retomadas (“peraí”,
   “de novo”), gaguejos, trechos sem áudio, demonstrações visuais (movimento sem
   fala) e nota de cada take, com o ⭐ melhor take entre tentativas parecidas.
   Cada sugestão tem **Ouvir / Aprovar / Recusar** — nada é cortado sozinho.
4. **Montar vídeo** — botão **MONTAR MEU VÍDEO** sugere a ordem em 6 etapas
   (gancho, apresentação, demonstração, aplicação, benefícios, CTA) usando só
   trechos que você gravou. Aprove item por item e aplique à timeline.
5. **Timeline** — dividir (S), mover, aparar bordas, reordenar, excluir,
   excluir e juntar, marcar trecho (I/O ou Shift+arrastar na régua) e excluir
   (X), zoom (Ctrl+roda), desfazer/refazer (Ctrl+Z / Ctrl+Y), volume por clipe.
6. **Sincronização** — escolha o que acontece ao inserir/excluir:
   *Deslocar tudo junto*, *Deslocar só o vídeo* ou *Não deslocar (sobrescrever)*.
   Vincule uma narração a um ponto do vídeo (🔗) para que ela acompanhe o take
   aonde ele for; ajuste fino de ±1 quadro, ±0,1 s, ±0,5 s. A barra de sincronia
   mostra em **vermelho** áudio sem vídeo e em **laranja** vídeo sem áudio.
7. **Legendas / Textos** — gere as legendas da transcrição, corrija palavras
   (uma a uma ou “trocar em todas”), divida falas, ajuste fonte, tamanho, cores,
   caixa de fundo e posição. As legendas ficam presas à fala: se o take mudar de
   lugar, elas vão junto.
8. **EXPORTAR VÍDEO** — MP4, H.264, 1080×1920 (9:16), 30 fps, áudio AAC, mais um
   `.srt`. A **Prévia rápida** gera 540×960 para conferir gastando menos
   processamento. Os vídeos ficam em **Exportações**.

Tudo é salvo automaticamente (com cópia de segurança `projeto.json.bak`).

---

## Arquitetura

```
ugc-lite/
├── Iniciar Meu Estudio UGC Lite.bat   ← clique duplo (Windows)
├── app.py                              ← inicia o servidor local e abre o navegador
├── estudio/                            ← backend em Python (somente biblioteca padrão)
│   ├── servidor.py     API JSON + arquivos (127.0.0.1, com suporte a Range para vídeo)
│   ├── tarefas.py      fila de 1 tarefa por vez, progresso, cancelamento, erros claros
│   ├── projetos.py     projetos em JSON, gravação atômica, backup
│   ├── midia.py        ffprobe, miniatura, versão leve (proxy 640p), tira de quadros, forma de onda
│   ├── analise.py      silêncios, movimento, heurísticas de fala, nota e melhor take
│   ├── transcricao.py  Faster-Whisper tiny/int8/CPU, carregado sob demanda e liberado depois
│   ├── montagem.py     MONTAR MEU VÍDEO (6 etapas, só material real + briefing)
│   ├── legendas.py     legendas a partir das palavras transcritas
│   └── exportacao.py   monta o comando FFmpeg (cortes dos ORIGINAIS + ASS + mixagem)
├── web/                                ← interface (HTML/CSS/JS puro, sem internet)
│   └── js/ linha_tempo.js (núcleo da timeline e da sincronização, testado),
│           editor.js, timeline_ui.js, paineis.js, player.js, app.js…
├── testes/                             ← testes automáticos
└── dados/  (criada no primeiro uso; fora do Git)
    ├── config.json
    └── projetos/<id>/ projeto.json · originais/ · cache/ · analise/ · exportacoes/
```

**Edição não destrutiva:** a timeline guarda apenas referências (arquivo +
início/fim). Os originais são somente lidos — inclusive na exportação, que corta
direto deles para manter a qualidade.

**Desempenho no i3 / 8 GB:** um processamento por vez; Whisper `tiny` `int8`
na CPU com 4 núcleos, liberado da memória quando a fila esvazia; edição com
versões leves (proxies) para reprodução fluida; exportação `veryfast`; Intel
Quick Sync opcional (experimental) com volta automática para CPU.

### Etapas de desenvolvimento (concluídas e testadas)

1. Base: servidor local, projetos, configurações e diagnóstico de FFmpeg/Whisper.
2. Importação: cópia ou referência, metadados, miniaturas, proxies, forma de onda.
3. Editor: timeline multipista, pré-visualização em tempo real, desfazer/refazer, salvamento automático.
4. Sincronização inteligente: modos de inserção, narração vinculada, barra de sincronia.
5. Análise IA: transcrição, pausas, repetições, erros, demonstrações, melhores takes, aprovação.
6. MONTAR MEU VÍDEO.
7. Legendas e textos.
8. Exportação final e prévia, página de Exportações.

---

## Para desenvolvimento

```powershell
cd ugc-lite
py -3.11 app.py                                 # inicia (use --sem-navegador / --porta 8800)
py -3.11 -m unittest discover -s testes -v      # testes do backend (usa Whisper simulado)
node --test testes/linha_tempo.test.mjs         # testes da timeline/sincronização (Node 18+)
```

A pasta de dados pode ser trocada com a variável `UGC_LITE_DADOS`.
