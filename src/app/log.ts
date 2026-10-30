/**
 * Registro de atividade do usuário. Cada linha vai para `logs/omnislice-AAAA-MM-DD.log` na pasta do
 * projeto (gravado pelo servidor do Vite) e também fica guardada no navegador, para "Baixar log".
 */
export type LogLevel = "info" | "acao" | "aviso" | "erro";

const ENDPOINT = "/__omnislice/log";
const KEEP = 3000;
const STORAGE_KEY = "omnislice-log";
const session = Math.random().toString(36).slice(2, 8);

let recent: string[] = [];
try {
  recent = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
} catch {
  recent = [];
}
let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function detail(data: unknown): string {
  if (data === undefined) return "";
  if (data instanceof Error) return ` | ${data.name}: ${data.message}${data.stack ? `\n${data.stack}` : ""}`;
  try {
    return ` | ${JSON.stringify(data)}`;
  } catch {
    return ` | ${String(data)}`;
  }
}

function flush() {
  timer = null;
  if (!pending.length) return;
  const body = pending.join("\n");
  pending = [];
  fetch(ENDPOINT, { method: "POST", body, keepalive: true }).catch(() => {
    // Sem servidor (ex.: dist aberto direto): o log continua disponível em "Baixar log".
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // Armazenamento cheio ou bloqueado.
  }
}

export function log(level: LogLevel, message: string, data?: unknown) {
  const line = `${new Date().toISOString()} [${session}] ${level.toUpperCase().padEnd(5)} ${message}${detail(data)}`;
  recent.push(line);
  if (recent.length > KEEP) recent = recent.slice(-KEEP);
  pending.push(line);
  if (level === "erro") flush();
  else if (!timer) timer = setTimeout(flush, 1000);
}

/** Baixa o log guardado no navegador (sessões recentes). */
export function downloadLog() {
  const blob = new Blob([recent.join("\n") + "\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `omnislice-log-${new Date().toISOString().slice(0, 10)}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function installGlobalLogging(version: string) {
  log("info", `Sessão iniciada (OmniSlice ${version})`, { navegador: navigator.userAgent, tela: `${screen.width}x${screen.height}` });
  window.addEventListener("error", (e) => log("erro", `Erro não tratado: ${e.message}`, e.error ?? `${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => log("erro", "Promessa rejeitada sem tratamento", e.reason));
  window.addEventListener("pagehide", flush);
}
