import { existsSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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
 * In dev mode the host side runs Vite in middleware mode with this config;
 * plugin pages are then served from their sources through this server
 * (`/@fs/…`), see {@link packageSourceAlias}.
 */
export default defineConfig(({ isSsrBuild }) => ({
    plugins: [packageSourceAlias(), react(), tailwindcss()],
    ssr: {
        noExternal: isSsrBuild ? true : undefined,
    },
    server: {
        fs: {
            // `/@fs/` may read the monorepo (plugin page sources); keep the
            // instance's config, secrets and runtime data out of it.
            deny: [
                ".env",
                ".env.*",
                "*.{crt,pem}",
                "**/.git/**",
                "**/config/**",
                "**/data/**",
                "**/tmp/**",
            ],
        },
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

/**
 * The shadcn alias `@/` → `<package>/src`, resolved per importer: against
 * the `src/` of the package the importing file belongs to. For this
 * package's own files that is `plugins/web-ui/src`; for plugin page
 * sources served through this server in dev mode (`/@fs/…`) it is the
 * plugin's own `src/`. A static `resolve.alias` cannot do this (it would
 * send every plugin's `@/` into this package).
 *
 * @returns The Vite plugin.
 */
function packageSourceAlias(): Plugin {
    const ownRoot = path.resolve(import.meta.dirname);
    const packageRoots = new Map<string, string | null>();
    /**
     * Nearest directory above `file` holding a package.json (cached).
     *
     * @param file Absolute importer path.
     * @returns The package root, or null.
     */
    const packageRootOf = (file: string): string | null => {
        const start = path.dirname(file);
        const cached = packageRoots.get(start);
        if (cached !== undefined) {
            return cached;
        }
        let dir = start;
        let found: string | null = null;
        for (;;) {
            if (existsSync(path.join(dir, "package.json"))) {
                found = dir;
                break;
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
                break;
            }
            dir = parent;
        }
        packageRoots.set(start, found);
        return found;
    };
    return {
        name: "familiar-package-source-alias",
        enforce: "pre",
        async resolveId(source, importer, options) {
            if (!source.startsWith("@/") || importer === undefined) {
                return null;
            }
            const root = packageRootOf(importer.split("?")[0] as string) ?? ownRoot;
            return this.resolve(path.join(root, "src", source.slice(2)), importer, {
                ...options,
                skipSelf: true,
            });
        },
    };
}
