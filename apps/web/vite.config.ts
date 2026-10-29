import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.DUOBOOK_WEB_PORT ?? 5173),
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.DUOBOOK_API_PORT ?? 8000}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: true,
  },
});
