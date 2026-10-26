# Análise dos sites de referência (REA)

Análise feita em 24/10/2026 com o **REA 6.7.0** (CLI local do repositório `rea/rea`), num Chromium
isolado e sem login (perfil temporário, sem cookies do usuário). Os parâmetros de anúncio dos links
recebidos (`utm_*`, `gclid`, `gbraid`, `gad_*`) foram removidos antes de abrir as páginas, para não
registrar cliques de campanha. Foram analisadas apenas páginas públicas.

As evidências originais (JSON do REA e capturas de tela) estão em [`rea-evidencias/`](rea-evidencias/).
O código-fonte dos sites **não** foi copiado para este projeto; só se registraram fatos observáveis
(textos da página, nomes de bibliotecas carregadas, rotas). O OmniSlice foi escrito do zero.

## Resumo

| Site | O que foi possível ver | Evidência |
| --- | --- | --- |
| Meshy (`meshy.ai/pt-BR`) | Página inicial e página de impressão 3D. Recursos de impressão descritos publicamente. O editor fica atrás de login. | `ev_5632f52a…`, `ev_ba7f4494…`, `ev_bad0475b…` |
| Obloid (`obloid.app`) | Página inicial, **STL Cutter** (funciona no navegador), **AI Model Splitter** (exige login) e **Color 3MF Splitter**. Análise estática do pacote do STL Cutter. | `ev_7243cb2f…`, `ev_31c3989a…`, `ev_f023e978…`, `ev_d20b9d27…`, `ev_23d7156a…` |
| Tripo (`studio.tripo3d.ai`) | **Bloqueado**: o Cloudflare exibiu "Confirme que é humano" para o navegador automatizado. A verificação não foi contornada. | `ev_95c7bb4f…` |

## Meshy

**Observado** (texto da página, `inspect_web_page` com texto de acessibilidade):

- "Verificação de imprimibilidade: marca furos, arestas non-manifold e problemas de watertightness".
- "A IA corrige automaticamente malhas quebradas e arestas não-manifold" (Auto Repair).
- "Divide modelos complexos em partes estanques, pré-dispostas na base de impressão" (Auto Split).
- "Cores dos vértices para Bambu AMS, Creality CFS e OrcaSlicer".
- Exportação em STL, OBJ e 3MF; envio direto ao Bambu Studio, OrcaSlicer, Cura etc.
- Redimensionar antes de exportar.

**Não verificado:** como o Auto Split decide os cortes, se cria encaixes e como fecha as faces. Esses
detalhes ficam no aplicativo autenticado, que não foi aberto.

## Obloid

**Observado** na página do STL Cutter (`ev_31c3989a…`):

- Ferramentas de corte: **Line** (edição local), **Band** (laço elástico), **Rope** (unir pontas),
  **Plane** (corte plano com setas de mover e anéis de girar).
- Encaixes: **None, Dowel, Snap, Tenon, Thread**; controles de **tamanho (%)** e **folga** ("0,11 mm · auto").
- Texto: "os pinos se ajustam à face de corte e à espessura de cada metade"; "a folga automática usa a
  tabela de encaixe sob pressão do PLA mais compensação de furo menor".
- "Tudo roda no navegador. O login só é exigido para baixar"; 3 exportações grátis por ferramenta.
- Mostra dimensões e contagem de triângulos do modelo.

**Observado** na análise estática do pacote (`analyze_web_bundle`, `ev_23d7156a…`, e scripts exportados
pelo `export_web_scripts`, `ev_d4d436cb…`):

- Aplicativo SvelteKit empacotado com Vite (inferência do REA, confiança média).
- Carrega `manifold.wasm` (biblioteca **Manifold** de geometria booleana).
- three.js r184, three-mesh-bvh (`MeshBVH`), carregadores STL/OBJ/3MF/GLTF, `OrbitControls`,
  `TransformControls`, `STLExporter` e fflate.
- O corte plano usa `splitByPlane` do Manifold com a seção (`slice`) para posicionar os pinos.
- Mensagem de erro: "The cut plane misses the model".
- As únicas chamadas de rede encontradas são de login e cobrança: o corte é feito no cliente.

**AI Model Splitter** (`ev_f023e978…`): "segmentação da malha inteira por IA", qualidade baixa ou alta
(2 créditos), roda em GPU no servidor, exige login.
**Color 3MF Splitter** (`ev_d20b9d27…`): separa um 3MF pintado no Bambu Studio em peças por cor.

## Tripo

A página respondeu com o desafio do Cloudflare (`ev_95c7bb4f…`). O REA respeita esse bloqueio e não
tenta burlá-lo. Para analisar o Tripo:

1. abra o site no seu Chrome com depuração remota (`--remote-debugging-port=9222`, perfil separado),
   passe pela verificação normalmente e
2. use `rea list-browser-targets http://127.0.0.1:9222` e `rea inspect-web-page …` na aba aberta.

## O que o OmniSlice adotou (decisões nossas, não cópia)

| Ideia vista | Como ficou no OmniSlice |
| --- | --- |
| Corte no navegador com Manifold (Obloid) | Mesmo motor (manifold-3d 3.5), num Web Worker, com rastreamento de faces de corte entre operações. |
| Corte plano com alças (Obloid) | Plano com `TransformControls` e prévia ao vivo por shader (frente azul, verso laranja). |
| Encaixes dimensionados pela seção (Obloid) | Diâmetro pelo maior círculo inscrito, comprimento pela profundidade medida com raios, folga por material e ajuste, e validação de colisão real. |
| Auto Split em peças estanques (Meshy) | Divisão automática geométrica local (espessura + juntas), editável por pintura, com cortes fechados. |
| Peças organizadas na mesa (Meshy) | Orientação pela maior face de corte com furo, empacotamento em uma ou mais mesas e 3MF por mesa. |
| Verificação/reparo de malha (Meshy, Obloid) | Diagnóstico (buracos, não-manifold, orientação, degeneradas, duplicadas, autointerseções), reparo e reconstrução por voxels. |
| Separar 3MF pintado (Obloid) | Leitura da pintura do Bambu/Prusa (`paint_color`/`mmu_segmentation`) e seleção ou divisão por cor. |

## Limitações desta análise

- As páginas autenticadas (editor do Meshy, AI Splitter do Obloid, estúdio do Tripo) não foram abertas.
- A análise estática mostra quais bibliotecas e chamadas existem, não o que foi executado.
- Os textos de marketing foram registrados como afirmações dos sites, não como fatos verificados.
