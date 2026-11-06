import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { mockApi } from "./mock";

// MOCK=1 serves sample data instead of proxying to `wrangler dev` (MOCK=signedout shows sign-in).
const mock = Boolean(process.env.MOCK);

export default defineConfig({
  root: __dirname,
  plugins: [preact(), tailwindcss(), ...(mock ? [mockApi()] : [])],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: mock ? {} : { "/api": "http://localhost:8787", "/decide": "http://localhost:8787" } },
});
