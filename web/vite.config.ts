import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.ORDO_API ?? "http://localhost:8080";
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/v1": api, "/health": api } },
  build: { outDir: "dist", sourcemap: true },
});
