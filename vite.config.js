import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// GitHub Pages بيخدم المشروع على /<repo>/ — الـ workflow بيمرّر VITE_BASE_PATH.
// محليًا وعلى Render/الدومين الجذري بيفضل "/" فالمسارات متتغيّرش.
const base = process.env.VITE_BASE_PATH || "/";

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": "http://127.0.0.1:3001",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
