// Teste ponta a ponta no navegador: carrega o exemplo, divide, valida encaixes e exporta.
// Uso: npm run build && node scripts/e2e.mjs [--url http://localhost:4173] [--out pasta]
// O Chromium vem de CHROME_PATH ou do cache do Playwright (ms-playwright/chromium-*).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { unzipSync } from "fflate";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = resolve(arg("--out", "e2e-output"));
mkdirSync(outDir, { recursive: true });

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
    join(homedir(), "Library", "Caches", "ms-playwright"),
  ].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      for (const rel of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const p = join(root, dir, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error("Chromium não encontrado. Defina CHROME_PATH.");
}

// Servidor estático mínimo para dist/ (evita depender do vite preview).
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml" };
async function serve(dir) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = join(dir, path === "/" ? "index.html" : path);
    try {
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

const external = arg("--url", null);
const local = external ? null : await serve(resolve("dist"));
const url = external ?? local.url;
const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

const step = async (name, fn) => {
  const t0 = Date.now();
  await fn();
  console.log(`✓ ${name} (${Date.now() - t0} ms)`);
};
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`) });
const idle = () => page.waitForFunction(() => !document.querySelector(".busy"), null, { timeout: 180000 });
const partsCount = () => page.locator(".parts-list li").count();

try {
  await step("abre a página inicial", async () => {
    await page.goto(url);
    await page.getByText("Arraste o arquivo para cá").waitFor();
    await shot("01-inicio");
  });
  await step("carrega o boneco de exemplo", async () => {
    await page.getByText("Carregue o boneco de exemplo").click();
    await page.locator(".parts-list li").first().waitFor({ timeout: 120000 });
    await idle();
    await page.waitForTimeout(500);
    await shot("02-modelo");
  });
  await step("analisa e sugere partes", async () => {
    await page.locator(".stages button", { hasText: "Dividir" }).click();
    await page.getByRole("button", { name: "Analisar e sugerir partes" }).click();
    await page.locator(".regions li").nth(3).waitFor({ timeout: 120000 });
    await idle();
    const names = await page.locator(".region-name").evaluateAll((els) => els.map((e) => e.value));
    console.log("  regiões:", names.join(", "));
    if (!names.some((n) => n.startsWith("Cabeça"))) throw new Error("A análise não encontrou a cabeça.");
    await shot("03-regioes");
  });
  await step("gera as peças", async () => {
    await page.getByRole("button", { name: "Gerar peças" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".parts-list li").length > 3, null, { timeout: 180000 });
    await idle();
    console.log("  peças:", await partsCount());
    await page.waitForTimeout(500);
    await shot("04-pecas");
  });
  await step("corta uma peça com plano", async () => {
    await page.locator(".parts-list li", { hasText: "Tronco" }).first().click();
    await page.getByRole("button", { name: "Cortar com plano" }).click();
    await page.getByRole("button", { name: "Cortar", exact: true }).waitFor();
    await page.waitForTimeout(300);
    await shot("05-plano");
    const before = await partsCount();
    await page.getByRole("button", { name: "Cortar", exact: true }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".parts-list li").length > n, before, { timeout: 120000 });
    await idle();
  });
  await step("planeja e valida encaixes", async () => {
    await page.locator(".stages button", { hasText: "Encaixes" }).click();
    await page.locator(".interfaces li").first().waitFor({ timeout: 60000 });
    await page.waitForFunction(() => !document.body.innerText.includes("Calculando…"), null, { timeout: 120000 });
    await page.locator(".interfaces li").first().click();
    await page.waitForTimeout(400);
    await shot("06-encaixes");
    await page.getByRole("button", { name: "Validar encaixes" }).click();
    await page.getByText(/cortes com encaixe validado/).waitFor({ timeout: 180000 });
    const summary = await page.getByText(/cortes com encaixe validado/).innerText();
    console.log("  ", summary);
    await shot("07-validado");
  });
  await step("organiza na mesa", async () => {
    await page.locator(".stages button", { hasText: "Impressão" }).click();
    await idle();
    await page.getByRole("radio", { name: "Organizada na mesa" }).click();
    await page.waitForTimeout(800);
    await shot("08-mesa");
    // Gira a primeira peça 90° em X e confere que a disposição foi refeita.
    await page.locator(".rotate-cell button", { hasText: "X" }).first().click();
    await idle();
    await page.locator(".rotate-cell button", { hasText: "auto" }).first().waitFor({ timeout: 60000 });
  });
  await step("exporta o ZIP", async () => {
    await page.locator(".stages button", { hasText: "Exportar" }).click();
    await idle();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 180000 }),
      page.getByRole("button", { name: "Baixar ZIP" }).click(),
    ]);
    const path = join(outDir, download.suggestedFilename());
    await download.saveAs(path);
    const files = Object.keys(unzipSync(new Uint8Array(await readFile(path))));
    console.log(`  ${download.suggestedFilename()}: ${files.length} arquivos`);
    for (const f of files.slice(0, 40)) console.log("   -", f);
    const need = ["LEIAME.txt"];
    for (const n of need) if (!files.includes(n)) throw new Error(`Faltou ${n} no ZIP.`);
    if (!files.some((f) => f.startsWith("montada/") && f.endsWith(".stl"))) throw new Error("ZIP sem STL da versão montada.");
    if (!files.some((f) => f.startsWith("impressao/") && f.endsWith(".3mf"))) throw new Error("ZIP sem 3MF da versão para impressão.");
    writeFileSync(join(outDir, "zip-files.txt"), files.join("\n"));
  });
  if (errors.length) {
    console.log("Erros no console do navegador:");
    for (const e of errors) console.log("  ", e);
    process.exitCode = 1;
  } else console.log("Sem erros no console.");
} catch (e) {
  console.error("FALHOU:", e.message);
  await shot("erro").catch(() => {});
  for (const err of errors) console.error("  console:", err);
  process.exitCode = 1;
} finally {
  await browser.close();
  local?.server.close();
}
