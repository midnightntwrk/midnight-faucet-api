import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const API_URL =
    typeof env.VITE_API_URL === "string"
      ? env.VITE_API_URL
      : mode === "production"
      ? "/api"
      : "http://localhost:5300/api";

  const USE_FAKE_API = !!env.VITE_USE_FAKE_API;
  const TURNSTILE_SITE_KEY =
    mode === "production" ? "0x4AAAAAACBzojXQuX0OQQQ0" : "1x00000000000000000000AA";

  return {
    plugins: [wasm(), react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
      extensions: [".tsx", ".ts", ".js"],
    },
    build: {
      outDir: "dist",
    },
    define: {
      API_URL: JSON.stringify(API_URL),
      USE_FAKE_API: JSON.stringify(USE_FAKE_API),
      TURNSTILE_SITE_KEY: JSON.stringify(TURNSTILE_SITE_KEY),
    },
    server: {
      hmr: {
        overlay: false,
      },
    },
  };
});
