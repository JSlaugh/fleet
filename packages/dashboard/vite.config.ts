import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 4401,
    proxy: {
      "/api": "http://localhost:4400",
      "/ws": { target: "ws://localhost:4400", ws: true },
    },
  },
});
