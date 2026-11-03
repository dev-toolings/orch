import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.DEV_PORT ?? 7894);
const api = process.env.DASH_API?.trim() || "http://127.0.0.1:7895";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-router-dom",
      "three",
      "@react-three/fiber",
      "@react-three/drei",
    ],
  },
  server: {
    host,
    port: Number.isInteger(port) && port > 0 ? port : 7894,
    strictPort: true,
    warmup: {
      clientFiles: [
        "./src/main.tsx",
        "./src/App.tsx",
        "./src/pages/Overview.tsx",
        "./src/pages/Runs.tsx",
        "./src/pages/Providers.tsx",
        "./src/pages/Spend.tsx",
        "./src/pages/Floor.tsx",
      ],
    },
    proxy: {
      "/api": {
        target: api,
        changeOrigin: true,
        timeout: 0,
      },
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("three") || id.includes("@react-three")) return "scene";
        },
      },
    },
  },
});
