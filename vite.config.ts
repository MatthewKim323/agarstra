import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  server: {
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4318", "/lab": "http://127.0.0.1:4318" },
  },
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/e2e/**"] },
});
