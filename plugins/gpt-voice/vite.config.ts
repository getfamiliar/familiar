import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Builds the voice page as a self-contained ES module
 * (`build/page/page.js`) whose default export mounts the page into the
 * web UI's content area. React is bundled (the web UI's own instance is
 * not shared in production); the CSS is inlined by the module itself.
 *
 * In dev mode this config is not used: the web UI's Vite server serves
 * `src/page.tsx` from source.
 */
export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "./src"),
        },
    },
    define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
    },
    build: {
        outDir: "build/page",
        emptyOutDir: true,
        lib: {
            entry: path.resolve(import.meta.dirname, "src/page.tsx"),
            formats: ["es"],
            fileName: () => "page.js",
        },
        rollupOptions: {
            output: {
                chunkFileNames: "assets/[name]-[hash].js",
                assetFileNames: "assets/[name]-[hash][extname]",
            },
        },
    },
});
