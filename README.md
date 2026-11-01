# OmniSlice — divisão inteligente de modelos 3D para impressão

Aplicativo web que transforma um modelo 3D inteiro (STL, OBJ, 3MF, GLB, PLY, de qualquer origem) em
**peças separadas, fechadas, com encaixes e prontas para o fatiador**. Tudo roda no navegador; o
modelo não sai do computador.

## Como rodar

Requer Node.js 20.19+ (testado com 24.22). Passo a passo completo em [INSTALACAO.md](INSTALACAO.md).

```bash
npm install
npm run dev        # abre em http://localhost:5173
npm run build      # checa tipos e gera dist/ (site estático)
npm run preview    # serve o dist/
npm test           # testes do núcleo geométrico (Vitest)
npm run e2e        # teste ponta a ponta no navegador (precisa do build e de um Chromium)
```

O `dist/` é um site estático: pode ser publicado em qualquer hospedagem (Netlify, Vercel, GitHub Pages,
um servidor próprio). O teste `e2e` usa o Chromium do cache do Playwright ou o caminho em `CHROME_PATH`.

## Fluxo (5 etapas)

1. **Modelo**: importar; ver dimensões, volume e defeitos (buracos, arestas não-manifold, orientação,
   faces degeneradas e duplicadas, autointerseções); ajustar escala e orientação; reparar
   automaticamente ou reconstruir por voxels quando a malha estiver muito quebrada.
2. **Dividir**:
   - *Automática*: o módulo de segmentação sugere cabeça, tronco, braços, pernas, mãos, pés e base.
   - *Por seleção*: escolha o que separar ("só a cabeça", "cabeça e membros", "tudo") ou marque/junte
     regiões uma a uma; o que não for separado continua unido ao corpo principal.
   - *Manual assistida*: pincel geodésico, borracha, balde (para em arestas vivas), seleção da casca
     inteira e seleção por cor, material ou objeto do arquivo (incluindo 3MF pintado no Bambu Studio
     ou PrusaSlicer e GLB texturizado).
   - *Corte por plano*: plano com alças de mover/girar e prévia ao vivo (frente azul, verso laranja).
     Só as cascas que o plano atravessa são cortadas; as outras vão inteiras para o lado delas.
   - "Gerar peças" corta cada junção por um plano ajustado ao contorno, ou segue o contorno pintado
     quando o plano atravessaria outra parte. As faces de corte são fechadas e cada peça é validada
     como sólido estanque.
   - Arquivos com várias cascas (3MF multipartes, acessórios e detalhes modelados à parte, vários
     objetos no projeto): uma casca pintada inteira vira peça sem nenhuma booleana, e só as cascas
     com mais de uma região pintada são cortadas, cada uma sozinha. Acessórios soltos sem pintura
     cravados numa única região separada (o logotipo de um chapéu, uma espada na mão) vão junto
     com ela.
3. **Encaixes**:
   - Tipos: pino cilíndrico, quadrado, sextavado ou em D; cavilha avulsa; alojamento para ímã.
   - Tamanho e comprimento automáticos (pela seção do corte e pela espessura medida) ou manuais.
   - Folga por material (PLA, PETG, ABS, TPU, resina) e ajuste (justo, normal, folgado).
   - Parede mínima até a borda, chanfro e quantidade por corte.
   - Editor 2D da face de corte para arrastar, adicionar e remover pinos.
   - Validação real: o pino montado não colide, nenhum furo vaza a parede e encaixes de cortes vizinhos
     não se cruzam.
4. **Impressão**:
   - Escolha da impressora/mesa, com predefinições ou medidas próprias.
   - Verificação de se cada peça cabe e divisão automática das que não cabem.
   - Orientação de cada peça pela face de corte plana, empacotamento em uma ou mais mesas.
   - Avisos de peças pequenas e paredes finas; estimativa de volume e massa.
5. **Exportar**: ZIP com STL por peça, projeto 3MF (cada peça como objeto, com nome e cor) e OBJ, nas
   versões *montada* e *organizada para impressão* (3MF por mesa), mais um `LEIAME.txt` com as medidas
   e os encaixes. Os nomes seguem as peças: `cabeca.stl`, `braco_esquerdo.stl`, `base.stl`…

Desfazer/refazer (Ctrl+Z / Ctrl+Y) cobre todas as operações; "Restaurar" volta ao arquivo como foi
importado. O arquivo original nunca é alterado.

## Arquitetura

```
src/
  core/           Núcleo geométrico, sem DOM (testável no Node)
    mesh.ts         malha indexada, solda, adjacência, medidas
    analysis.ts     diagnóstico de defeitos
    repair.ts       reparo e fechamento de buracos
    remesh.ts       reconstrução por voxels (Manifold.levelSet)
    split.ts        corte por plano, divisão por regiões, interfaces entre peças
    connectors.ts   planejamento, geometria e validação dos encaixes
    layout.ts       orientação, verificação de mesa e distribuição em mesas
    io/             leitores e escritores STL, OBJ e 3MF (inclui a pintura do Bambu/Prusa)
  segmentation/   Módulo independente de divisão automática (provedores)
  worker/         Web Worker com o Manifold (WASM) e protocolo tipado
  viewer/         Cena three.js: cores, pincel, plano de corte, encaixes e mesas
  app/            Interface React (painéis, estado, histórico, ações)
```

- **Manifold** (WASM) faz as booleanas com garantia de sólido fechado. Cada triângulo carrega a
  origem (face do modelo importado) e a marca do corte que o criou, então interfaces, cores e
  materiais sobrevivem a cortes sucessivos.
- **three.js + three-mesh-bvh** cuidam da visualização, da seleção por raio e da medição de espessura.
- Operações pesadas rodam no worker e podem ser canceladas. Malhas densas são segmentadas numa cópia
  simplificada (cerca de 30 mil triângulos) e os rótulos voltam para a malha original.

## Módulo de divisão automática (IA)

A divisão automática é um módulo isolado ([`src/segmentation/`](src/segmentation/)). Todo provedor
implementa `SegmentationProvider` e devolve **um rótulo por triângulo**. As ferramentas manuais só
consomem esse resultado, então o módulo pode evoluir sem mexer nelas.

Provedores incluídos:

- **Geométrica**: mede a espessura local (Shape Diameter Function), agrupa regiões parecidas e funde as
  que não estão separadas por uma junta côncava; nomeia as partes pela posição. **Não é IA**: é uma base
  local, sem internet. Funciona bem em figuras com membros e cabeça; em modelos muito diferentes, use a
  pintura para corrigir.
- **Cascas**, **cores**, **materiais** e **objetos**: usam a informação que o próprio arquivo já traz.
- **Serviço de IA remoto** (opcional, desligado por padrão): configurado por URL na interface. O
  OmniSlice envia `POST` com a peça em **STL binário** (`Content-Type: model/stl`) e espera
  `{"labels": number[], "names"?: string[]}`, com um rótulo por triângulo na ordem do STL.
  Qualquer modelo de segmentação de partes (servidor próprio, ONNX etc.) pode ser plugado assim.

## Testes

- `npm test` — 52 testes do núcleo:
  - análise e reparo;
  - cortes e divisão por regiões (com e sem segmentação automática, de 5 mil a mais de 100 mil triângulos);
  - encaixes, incluindo colisão, parede vazada, cavilha, ímã e conflito entre cortes;
  - STL, OBJ e 3MF de ida e volta, inclusive 3MF pintado com componentes;
  - mesa, inclusive a orientação escolhida à mão;
  - qualidade das peças (sem lascas, base cortada no topo plano);
  - arquivos com várias cascas: casca inteira sem booleanas, acessório cravado, acessório com folga,
    objeto oco, pedestal, casca dividida entre duas regiões, corte por plano só nas cascas que ele
    atravessa, andamento e limpeza da pintura.
- `npm run e2e` — abre o app num Chromium real e percorre:
  - carregar o exemplo, analisar e gerar as peças;
  - cortar uma peça por plano;
  - validar os encaixes, organizar na mesa e girar uma peça;
  - baixar o ZIP e conferir os arquivos e o console (capturas de tela em `e2e-output/`).

## Limitações conhecidas

- A divisão geométrica foi ajustada e testada sobretudo com o boneco de exemplo (figura fundida numa
  casca só). Modelos reais variados devem ser avaliados; a pintura manual resolve os casos em que a
  sugestão errar.
- Malhas que não são sólidos fechados precisam passar pelo reparo (ou pela reconstrução por voxels)
  antes de dividir. Buracos maiores que ~2 células de voxel impedem a reconstrução.
- Cortes por contorno (não planos) geram tampas que acompanham a pintura: são válidas, mas menos
  bonitas que cortes planos e podem deixar o pino inclinado. Quando a fronteira pintada é irregular
  demais (a tampa atravessaria a superfície ou fecharia um vão por fora), o corte usa um plano ou a
  região não é separada, com uma mensagem explicando como ajustar a pintura.
- Cascas que se cruzam no arquivo continuam se cruzando depois da divisão (o OmniSlice não recorta
  uma peça para abrir espaço para a outra).
- A massa é uma estimativa simples (paredes de 1,2 mm + preenchimento); use o fatiador para o valor real.
- Divisão de malhas de casca única acima de ~400 mil triângulos leva dezenas de segundos (cerca de
  20 s com 2 milhões de triângulos); em arquivos com várias cascas, só as cascas cortadas pesam.
- GLB comprimido (Draco/Meshopt) e PLY de nuvem de pontos não são lidos.

A análise dos sites de referência feita com o REA está em [docs/analise-concorrentes.md](docs/analise-concorrentes.md).
