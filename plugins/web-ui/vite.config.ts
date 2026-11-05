import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config of the web UI. `vite build` writes the client bundle to
 * `build/client`, which the plugin's host side serves in production; in
 * dev mode the host side runs Vite in middleware mode with this config.
 */
export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "./src"),
        },
    },
    build: {
        outDir: "build/client",
        emptyOutDir: true,
    },
});
