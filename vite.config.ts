import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { activityLog } from "./tools/logPlugin";

process.env.VITE_APP_VERSION ??= process.env.npm_package_version;

export default defineConfig({
  plugins: [react(), activityLog()],
  // O Manifold carrega o próprio .wasm; a pré-otimização quebraria o caminho relativo.
  optimizeDeps: { exclude: ["manifold-3d"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
