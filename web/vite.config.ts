import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { mockApi } from "./mock";

// MOCK=1 serves sample data (MOCK=signedout shows the signed-out screen). Without it, /api goes to a local
// backend on port 8787 if one is running; the real app runs on Azure (Sandbox).
const mock = Boolean(process.env.MOCK);

export default defineConfig({
  root: __dirname,
  plugins: [preact(), tailwindcss(), ...(mock ? [mockApi()] : [])],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: mock ? {} : { "/api": "http://localhost:8787", "/decide": "http://localhost:8787" } },
});
