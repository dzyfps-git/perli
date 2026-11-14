import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // three.js comes alone, with the first 3D model shown.
  // The film's small window is a page of its own, so it loads none of the file list.
  build: {
    target: "chrome120",
    chunkSizeWarningLimit: 700,
    rollupOptions: { input: { main: "index.html", mini: "mini.html" } },
  },
});
