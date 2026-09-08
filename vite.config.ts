import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  server: {
    strictPort: true,
    fs: {
      // Ignoring private context in git does not prevent dev-server downloads.
      // Keep Vite's built-in deny rules when adding the server-only directory.
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.nerve/**"],
    },
    proxy: { "/api": "http://127.0.0.1:4318", "/lab": "http://127.0.0.1:4318" },
  },
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/e2e/**"] },
});
