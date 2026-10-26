# Relatório da sessão: testes de corte de peças

Data: 24/10/2026
Pedido: "refaça os testes de corte de peças, preciso que seja impecável", usando o modelo
`C:\Users\Sony\Downloads\Bruce Lee 'Yoh Ho'.3mf` e a lista de critérios de qualidade enviada
(análise, execução dos cortes, conectores, validação dos encaixes, visualização/exportação e
critério de qualidade).

> **Atenção antes de usar o app:** o código está num estado intermediário. Há leituras de
> `process.env.OMNISLICE_DEBUG` e `process.env.OMNISLICE_ALL` em `src/core/split.ts` (depuração).
> No navegador `process` não existe, então **a divisão por regiões falha no app** até essas linhas
> serem removidas. É o primeiro passo da próxima sessão.

---

## 1. O modelo de teste

O 3MF é um projeto do Bambu Studio com 12 objetos já separados por cor e espalhados em 6 mesas
(posições de impressão, não montadas). Nomes lidos do projeto:

| # | Objeto | Triângulos | Volume (mm³) | Autointerseções no original |
|---|--------|-----------:|-------------:|----------------------------:|
| 1 | 底座 (base) | 9 568 | 60 326 | 67 |
| 2 | 左眼 (olho esq.) | 1 388 | 46,5 | 25 |
| 3 | 火焰_1 (chama 1) | 3 174 | 417 | 0 |
| 4 | 右眼 (olho dir.) | 612 | 10,2 | 0 |
| 5 | 身体_Boolean (corpo) | 52 888 | 32 480 | 634 |
| 6 | 火焰_2 (chama 2) | 1 614 | 147 | 0 |
| 7 | 裤子_Boolean_B (calça) | 27 014 | 32 532 | 284 |
| 8 | 脚 (pé) | 5 704 | 1 080 | 3 |
| 9 | 右眉 (sobrancelha dir.) | 374 | 28,6 | 0 (duas cascas encostadas numa aresta) |
| 10 | 脚2 (pé 2) | 6 036 | 1 114 | 0 |
| 11 | 左眉_Boolean (sobrancelha esq.) | 620 | 33,9 | 0 |
| 12 | 头发 (cabelo) | 51 474 | 55 897 | 26 |

Todos são malhas fechadas aceitas pelo Manifold, mas seis objetos chegam com dobras locais
(triângulos se atravessando). Medido: são dobras pequenas, de poucos mm² de área total por objeto,
com penetração mediana de 0,001 mm e máxima de 0,35 mm (cabelo).

O arquivo `boneco_exemplo.stl`, enviado antes por engano, é o boneco de exemplo exportado pelo
próprio app (15 092 triângulos, sem defeitos). Ele também foi usado nos testes.

---

## 2. O que foi feito

### 2.1 Verificador automático (`src/core/verify.ts`)

Transformei a lista de critérios em verificações automáticas e independentes. Elas medem as
malhas finais e não reaproveitam a construção que está sendo verificada.

**Corte (`verifyCut`)**, para cada peça e para o conjunto:
- malha fechada; normais coerentes;
- sem faces degeneradas ou duplicadas;
- sem autointerseções criadas pelo corte (as herdadas do modelo são só informadas);
- sólido válido; peça única, sem pedaços soltos;
- sem fragmento pequeno nem lâmina (comparado com a espessura do próprio modelo);
- volume conservado; peças sem sobreposição;
- montadas, voltam à forma e à posição originais;
- detalhes externos preservados (nenhum vértice fora da superfície original) e superfície original
  completa;
- toda face rastreável (cor, material e corte de origem);
- tampa gerada dos dois lados, plana, casada (mesma área), orientada para fora, com cada lado em
  uma peça independente;
- sem abas finas: região mais fina que 0,8 mm com mais de 3 mm de largura.

**Encaixes (`verifyConnectors`)**, medidos direto nas faces de encaixe, sem booleanas:
- macho numa peça e fêmea na outra; pino inteiro dentro da cavidade (teste de ponto dentro do
  sólido);
- alinhamento pela mesma referência; folga medida igual à configurada;
- as peças fecham na posição original (o pino não bate no fundo);
- raiz do pino embutida na peça macho; parede e fundo com espessura mínima;
- pino imprimível em FDM; sem colisão entre peças montadas;
- nada sai da superfície externa; nenhum furo vaza.

Abas e fragmentos têm gravidade configurável. Num corte por plano escolhido pelo usuário viram
**aviso**; na divisão automática, que é escolha do algoritmo, são **erro**.

### 2.2 Defeitos do corte encontrados pelo verificador e corrigidos

1. **Trinca dentro da peça (película dupla).** Ao reunir pedaços que o plano infinito cortou à toa
   (por exemplo, o plano do ombro atravessando a base), as duas faces do corte ficavam coladas por
   dentro da peça. O teste antigo deixava isso passar com tolerância de 0,1% de volume, e ainda
   descartava 91 mm³ como "lascas". Cada separação agora é **um único corte exato** do sólido
   original por um cortador limitado a um envoltório da peça (caixa ou casco convexo). Uma
   checagem exata garante que o envoltório não encostou no sólido. Arquivo: `src/core/split.ts`
   (`exactSplit`, `planarPeel`, migalhas do `cutByPlane`).
2. **Objetos ocos perdiam a cavidade.** `Manifold.decompose()` devolve a cavidade como uma peça
   "do avesso", que `compose` e `union` descartam. Agora a decomposição é exata e preserva o
   vazio. Arquivo: `src/core/solids.ts` (`decomposeSolids`).
3. **Lascas descartadas no modo "separar pedaços soltos".** Lascas minúsculas encostadas no outro
   lado passaram a voltar para o lado que tocam, sem perder superfície.
4. **Diagnóstico e reparo de objetos ocos e cascas sobrepostas.** A cavidade não é mais
   "corrigida" como se fosse normal invertida, e a análise informa cavidades e cascas sobrepostas.
   Arquivos: `src/core/analysis.ts`, `src/core/repair.ts`.
5. **Contagem de autointerseções exagerada.** Triângulos que só se tocavam contavam como
   cruzamento. Novo teste de cruzamento real em `src/core/intersect.ts`, usado em `src/core/bvh.ts`.

### 2.3 Reparo de dobras locais (`src/core/repair.ts`, opção `fixSelfIntersections`)

Primeiro, uma suavização amortecida só dos vértices das faces dobradas. O que sobrar é recortado
com a menor vizinhança possível e fechado em leque, de forma que nenhuma aresta nova repita uma
existente.

Resultado nos objetos do Bruce Lee:

| Objeto | Cruzamentos | Faces refeitas | Malha final | Desvio máx. | Tempo |
|--------|-------------|---------------:|-------------|------------:|------:|
| base | 67 → 0 | 278 | fechada, manifold | 0,25 mm | 0,5 s |
| olho esq. | 25 → 0 | 0 | fechada, manifold | 0,22 mm | 0,03 s |
| corpo | 634 → 0 | 1 103 | fechada, manifold | 0,58 mm | 2,8 s |
| calça | 284 → 0 | 517 | fechada, manifold | 0,23 mm | 1,2 s |
| pé | 3 → 0 | 0 | fechada, manifold | 0,09 mm | 0,1 s |
| cabelo | 26 → 0 | 0 | fechada, manifold | 0,34 mm | 0,8 s |

O volume não mudou de forma mensurável.

### 2.4 Outras melhorias
- **Leitor de 3MF** (`src/core/io/threemf.ts`): lê nome e filamento de cada objeto no
  `model_settings.config` (Bambu/Orca) e no `Slic3r_PE_model.config` (Prusa). Antes aparecia
  "Objeto 1…12", sem cor.
- **Medida de abas** num módulo próprio (`src/core/flaps.ts`), usada pelo verificador e pela
  escolha automática do plano.
- A escolha automática do plano agora mede e penaliza abas, e avalia mais candidatos quando os
  primeiros deixam aba.

### 2.5 Resultados medidos
- Divisão automática da figura de exemplo com encaixes: **123 verificações de encaixe, todas
  aprovadas**.
- Os 36 testes automáticos antigos passaram na última rodada completa. Essa rodada foi **antes**
  das duas últimas mudanças (passo mais fino da grade de abas e avaliação de mais candidatos).
- Bateria de cortes por plano: 14 modelos × 13 planos × 2 modos = 364 cortes. A última rodada
  completa reprovou 173 cortes, mas foi feita **antes** das correções de fragmento, lascas e
  encaixes. A maioria das reprovações era do critério de fragmento, já corrigido (decalques finos
  eram tratados como lâmina). O restante:
  - **Planos de teste quase tangentes** criando abas reais. Isso é escolha do plano, e o
    verificador avisa.
  - **Cortes atravessando as dobras** dos objetos sem reparo. O reparo novo deve resolver; ainda
    não foi conferido na bateria.

---

## 3. Onde parei: problemas em aberto

1. **Código de depuração quebra o app.** Remover as linhas `process.env.OMNISLICE_DEBUG` e
   `process.env.OMNISLICE_ALL` de `src/core/split.ts` (função `exactSplit` e laço de candidatos do
   `planarPeel`).
2. **Regressão ainda não investigada.** Na última execução, com o modo de depuração avaliando
   todos os candidatos de plano, apareceram:
   - 0,86 mm³ de volume perdido;
   - tampa do corte 3 com áreas diferentes dos dois lados;
   - cortes 5 e 6 com tampa só de um lado.

   Pode vir da liberação de memória (`free`) quando vários candidatos são avaliados, ou da
   mudança do passo da grade em `flaps.ts`. Ainda não está claro se acontece sem o modo de
   depuração.
3. **Aba no ombro da figura.** A divisão automática ainda deixa uma cunha de cerca de 3 mm mais
   fina que 0,8 mm no tronco, junto ao corte dos braços. Todos os candidatos de plano medidos
   ficaram entre 2,0 e 3,1 mm. Falta ajustar a penalização (hoje ela só começa em 3 mm) e talvez
   criar candidatos inclinados que encontrem a lateral do tronco num ângulo maior.
4. A bateria completa e os 36 testes precisam rodar de novo depois das últimas mudanças.

---

## 4. Próximos passos (em ordem)

1. Remover o código de depuração e resolver a regressão do item 3.2; rodar os 36 testes.
2. Fechar a escolha de plano sem abas na divisão automática (item 3.3).
3. Rodar a bateria completa no Bruce Lee **já reparado**: cortes por plano, cortes sucessivos e
   divisão automática com encaixes nos objetos grandes (corpo, calça, cabelo, base).
4. Criar o teste permanente `tests/cut-quality.test.ts` com:
   - modelos gerados: caixa girada, esfera, toro, caixa oca, cascas separadas e sobrepostas, placa
     fina e peça em U;
   - a figura de exemplo;
   - modelos reais lidos de uma pasta local fora do controle de versão, porque a licença do Bruce
     Lee ("Standard Digital File License") não permite redistribuir.
5. Usar o verificador dentro do app: relatório depois de cada corte e antes de exportar. Mostrar
   as autointerseções já na importação, que agora é rápida, e recomendar "Reparar".
6. Melhorar o reparo de dobras para mexer menos na superfície: hoje o desvio chega a 0,58 mm no
   corpo.
7. Na importação de 3MF com vários objetos, oferecer uma peça por objeto.
8. Atualizar o README, que ainda cita "36 testes" e não descreve verificador nem reparo de dobras.

---

## 5. Onde estão as coisas

- Código novo ou alterado em `src/core/`:
  - novos: `verify.ts`, `solids.ts`, `flaps.ts`, `intersect.ts`;
  - alterados: `split.ts`, `repair.ts`, `analysis.ts`, `bvh.ts`, `io/threemf.ts`.
- Scripts de teste temporários: `scratch/` dentro do projeto (fora do controle de versão).
  - `battery.test.ts`: cortes por plano.
  - `regions.test.ts`: divisão automática e encaixes.
  - `untangle.test.ts`: reparo de dobras.
  - `models.ts`: carrega os modelos.
  - Para rodar:
    ```
    MODEL_3MF=<caminho do 3mf> MODEL_STL=<caminho do stl> npx vitest run --config scratch/vitest.config.ts scratch/<arquivo> --silent=false
    ```
    `ONLY=<nome>` filtra um modelo.
- Cópia de trabalho do 3MF:
  `C:\Users\Sony\AppData\Local\Temp\claude\C--Users-Sony-Desktop-projetos-rea-rea\2f17d155-784b-4049-aae3-73288670e6e7\scratchpad\modelo-bruce-lee\bruce-lee.3mf`
- Log da última bateria completa: `scratch/battery-1.log`.
- Nada foi commitado. O projeto `impressao-3d` não é um repositório git.
