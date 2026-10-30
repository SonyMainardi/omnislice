import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Connect, Plugin } from "vite";

/** Recebe as linhas de `src/app/log.ts` e grava em `logs/` na pasta do projeto (dev e preview). */
export function activityLog(): Plugin {
  const dir = resolve(process.cwd(), "logs");
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url !== "/__omnislice/log" || req.method !== "POST") return next();
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      if (body.length < 1_000_000) body += c;
    });
    req.on("end", async () => {
      try {
        await mkdir(dir, { recursive: true });
        await appendFile(resolve(dir, `omnislice-${new Date().toISOString().slice(0, 10)}.log`), body + "\n", "utf8");
        res.statusCode = 204;
      } catch {
        res.statusCode = 500;
      }
      res.end();
    });
  };
  return {
    name: "omnislice-activity-log",
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}
