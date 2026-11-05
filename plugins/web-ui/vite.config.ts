import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config of the web UI, with two builds:
 *
 * - client (`vite build`): the SPA bundle in `build/client`, served by
 *   the plugin's host side in production;
 * - ssr (`vite build --ssr src/ssr/render-auth-page.tsx`): the login-page
 *   renderer in `build/ssr`, fully bundled (no runtime npm deps) and with
 *   every asset inlined as a `data:` URI, because those pages are served
 *   without authentication under a CSP that allows no external resources.
 *
 * In dev mode the host side runs Vite in middleware mode with this config.
 */
export default defineConfig(({ isSsrBuild }) => ({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "./src"),
        },
    },
    ssr: {
        noExternal: isSsrBuild ? true : undefined,
    },
    build: isSsrBuild
        ? {
              outDir: "build/ssr",
              emptyOutDir: true,
              assetsInlineLimit: () => true,
              rollupOptions: { output: { entryFileNames: "[name].js" } },
          }
        : {
              outDir: "build/client",
              emptyOutDir: true,
          },
}));
