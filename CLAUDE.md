# S.E.O Agent — notes for AI coding agents

Self-hosted SEO tool: Vite + TanStack Start (React) on the Cloudflare Workers runtime, SQLite (D1) via Drizzle, an MCP server at `/mcp`, and 31 agent skills under `.agents/skills` (synced into `plugins/seo-agent/skills` by `node scripts/sync-plugin-skills.mjs`; CI fails on drift).

The plugin has two halves. The MCP-backed skills read live SEO data from this app. The rest run on a bundled Python toolchain in `plugins/seo-agent/` (crawler, headless Chromium, schema, content, images) that needs no server and no credits — it is vendored from [claude-seo](https://github.com/ahmadaimee/claude-seo) and has its own pytest suite.

## Rules

- Self-host only. `AUTH_MODE=local_noauth` is the supported mode; hosted/billing code paths stay disabled. Never add telemetry or phone-home calls.
- Every SEO data call goes through `src/server/lib/dataforseo/`; nothing else talks to external SEO providers.
- Do not rename the `seo_agent_audit` worker/environment or the `DB` binding without updating `wrangler.jsonc`, `wrangler.audit.jsonc`, `vite.config.ts`, `alchemy.run.ts` and `docker-entrypoint.sh` together.
- Shell scripts and Dockerfiles are LF (`.gitattributes`); keep it that way.

## Commands

- `docker compose up -d --build` — run locally on port 3010 (first boot builds inside the container).
- `pnpm run build` — vite build + `tsc --noEmit`; `pnpm lint`; `pnpm test`.
- `pnpm sync-plugin-skills` after editing anything in `.agents/skills`, and add new skills to the `skills` array in `scripts/sync-plugin-skills.mjs`.
- `python -m pytest` in `plugins/seo-agent/` for the bundled Python toolchain.
