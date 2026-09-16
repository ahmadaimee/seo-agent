import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig, loadEnv } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { devtools } from "@tanstack/devtools-vite";
import { leanWorkerBundle } from "./vite-plugin-lean-worker-bundle";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = process.env.PORT
    ? Number(process.env.PORT)
    : env.PORT
      ? Number(env.PORT)
      : 3001;
  const showDevtools = env.VITE_SHOW_DEVTOOLS !== "false";
  // ALLOWED_HOST accepts a comma-separated list. A custom-domain cutover needs
  // two hostnames live at once — the platform subdomain that is already
  // serving and the new domain being pointed at it — and vite's preview server
  // rejects any Host header it was not given.
  const allowedHosts = [
    ...(env.ALLOWED_HOST?.split(",") ?? []),
    env.BETTER_AUTH_URL ? new URL(env.BETTER_AUTH_URL).hostname : undefined,
  ]
    .map((host) => host?.trim())
    .filter((host): host is string => Boolean(host));
  const emitSourcemaps = env.POSTHOG_SOURCEMAPS === "true";

  return {
    envPrefix: [
      "VITE_",
      "AUTH_MODE",
      "BYPASS_EMAIL_VERIFICATION",
      "POSTHOG_PUBLIC_KEY",
      "POSTHOG_HOST",
      "TURNSTILE_SITE_KEY",
    ],
    server: {
      allowedHosts,
      port,
    },
    preview: {
      allowedHosts,
      port,
    },
    build: {
      sourcemap: emitSourcemaps,
      outDir: emitSourcemaps ? "dist-sourcemaps" : "dist",
    },
    plugins: [
      leanWorkerBundle(),
      showDevtools
        ? devtools({
            consolePiping: {
              enabled: true,
              levels: ["log", "warn", "error", "info", "debug"],
            },
          })
        : null,
      cloudflare({
        inspectorPort: false,
        viteEnvironment: { name: "ssr" },
        // The site-audit aux worker builds to dist/seo_agent_audit/ and runs
        // beside the main worker in dev and preview, with the app's
        // cross-script SITE_AUDIT_WORKFLOW / AUDIT_SCRATCHPAD bindings
        // resolved against it.
        auxiliaryWorkers: [{ configPath: "./wrangler.audit.jsonc" }],
      }),
      tsConfigPaths(),
      tanstackStart(),
      viteReact(),
      tailwindcss(),
    ],
  };
});
