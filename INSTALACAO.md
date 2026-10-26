# Instalação e execução local

Guia passo a passo para rodar o OmniSlice no seu computador. Visão geral do projeto no [README](README.md).

## 1. Pré-requisitos

| Ferramenta | Versão | Observação |
|---|---|---|
| [Node.js](https://nodejs.org/) | **20.19 ou mais nova** (testado com 24.22) | Já inclui o `npm` |
| Navegador | Chrome, Edge ou Firefox recentes | Precisa de WebAssembly e Web Workers (todos os atuais têm) |
| Chromium/Chrome | opcional | Só para o teste ponta a ponta (`npm run e2e`) |

Confira as versões:

```bash
node -v
npm -v
```

Não há banco de dados, servidor nem chave de API: tudo roda no navegador.

## 2. Instalar

```bash
git clone https://github.com/SonyMainardi/omnislice.git
cd omnislice
npm install
```

Para instalar exatamente as versões travadas no `package-lock.json` (recomendado em CI), use `npm ci`.

## 3. Rodar em modo desenvolvimento

```bash
npm run dev
```

Abra **http://localhost:5173**. As alterações no código recarregam a página sozinhas.
Para usar outra porta: `npm run dev -- --port 3000`. Para abrir em outro aparelho da rede: `npm run dev -- --host`.

## 4. Primeiro teste com o corte de peças

1. Na etapa **Modelo**, clique em carregar o **exemplo** (boneco) ou arraste seu arquivo STL, OBJ, 3MF, GLB ou PLY.
2. Se a análise apontar defeitos, use **Reparar** antes de seguir.
3. Na etapa **Dividir**, use a divisão *automática* ou o *corte por plano* e clique em **Gerar peças**.
4. Em **Encaixes**, escolha o tipo de pino e o material e valide.
5. Em **Impressão**, escolha a mesa da sua impressora e organize as peças.
6. Em **Exportar**, baixe o ZIP com os STL/3MF e abra no seu fatiador.

Dica: comece com o modelo de exemplo, que é o caso mais testado, antes de usar modelos próprios.

## 5. Outros comandos

```bash
npm test           # testes do núcleo geométrico (Vitest, ~10 s)
npm run typecheck  # checagem de tipos TypeScript
npm run build      # gera o site estático em dist/
npm run preview    # serve o dist/ em http://localhost:4173
npm run e2e        # teste no navegador real (rode npm run build antes)
```

O `npm run e2e` procura o Chromium do cache do Playwright. Se não encontrar, aponte para um Chrome instalado:

```bash
# Windows (PowerShell)
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"; npm run e2e
# Linux / macOS
CHROME_PATH=/usr/bin/google-chrome npm run e2e
```

As capturas de tela e o ZIP gerado ficam em `e2e-output/`.

## 6. Problemas comuns

- **`npm install` reclama da versão do Node**: atualize para 20.19+ (ou use `nvm install 24`).
- **Porta 5173 ocupada**: o Vite escolhe a próxima livre; veja o endereço impresso no terminal.
- **Tela branca ou erro ao carregar o `.wasm`**: apague `node_modules/.vite` e rode `npm run dev` de novo.
- **Divisão lenta em modelos grandes**: malhas acima de ~400 mil triângulos levam dezenas de segundos; simplifique o modelo antes, se possível.
- **Peças não geradas**: a malha precisa ser um sólido fechado; rode o reparo ou a reconstrução por voxels na etapa Modelo.
