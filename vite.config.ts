import { readdirSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

/**
 * pdf.js's own files, which it fetches as a PDF needs them: character maps for Asian text, the
 * 14 standard fonts, and its WebAssembly: image decoders, colour profiles and the sandbox a
 * PDF's own scripts run in. The dev server serves them straight from node_modules.
 */
function pdfFiles(): Plugin {
  const folders: [string, (name: string) => boolean][] = [
    ["cmaps", () => true],
    ["standard_fonts", () => true],
    // The decoders and colour profiles as WebAssembly, and the engine a PDF's scripts run in.
    ["wasm", (name) => name.endsWith(".wasm") || name === "quickjs-eval.js" || name.startsWith("LICENSE")],
    // The icons of notes left on a page.
    ["web/images", (name) => name.startsWith("annotation-")],
  ];
  return {
    name: "pdf-files",
    apply: "build",
    generateBundle() {
      for (const [folder, wanted] of folders) {
        for (const name of readdirSync(`node_modules/pdfjs-dist/${folder}`).filter(wanted)) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${folder}/${name}`, source: readFileSync(`node_modules/pdfjs-dist/${folder}/${name}`) });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [solid(), pdfFiles()],
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
