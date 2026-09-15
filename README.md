# S.E.O Agent

Free, self-hosted SEO data and workflows for AI agents — keyword research, rank tracking, competitor insights, backlinks, site audits and AI visibility, exposed to Claude Code (and any MCP client) through an MCP server plus nine ready-made skills.

No account, no subscription, no telemetry. You run it, you own the data. The only external cost is DataForSEO, billed to you directly per API call.

## Run it

```bash
cp .env.example .env          # set DATAFORSEO_API_KEY (base64 of login:password)
docker compose up -d --build  # builds from source; first start takes ~3 minutes
```

App: `http://localhost:3010` · MCP server: `http://localhost:3010/mcp`

Auth is disabled locally (`AUTH_MODE=local_noauth`). For a public deployment set `SELFHOST_BASIC_AUTH_USER` and `SELFHOST_BASIC_AUTH_PASSWORD` to put HTTP Basic auth in front of everything except `/api/health`. A `railway.json` is included for Railway (build from `Dockerfile.selfhost`, mount a volume at `/app/.wrangler`).

Docs: [Docker self-hosting](docs/SELF_HOSTING_DOCKER.md) · [DataForSEO key](docs/DATAFORSEO_API_KEY.md) · [Google Search Console](docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md) · [Local development](docs/LOCAL_DEVELOPMENT.md)

## Use it from Claude Code

```
/plugin marketplace add ahmadaimee/seo-agent
/plugin install seo-agent@seo-agent
```

The plugin's MCP entry defaults to `http://localhost:3010/mcp`. For a hosted instance set two environment variables on your machine:

- `SEO_AGENT_MCP_URL` — e.g. `https://your-host/mcp`
- `SEO_AGENT_MCP_AUTH` — e.g. `Basic <base64 user:password>` when Basic auth is on

Skills: `/seo-project-setup`, `/keyword-research`, `/keyword-clustering`, `/competitor-analysis`, `/competitive-landscape`, `/seo-audit`, `/local-seo`, `/link-prospecting`, `/seo-coach`.

## What needs a key

| Feature | Needs |
|---|---|
| Keywords, SERPs, backlinks, rank tracking, audits (Lighthouse), AI visibility | `DATAFORSEO_API_KEY` |
| SAM, the in-app chat agent | `OPENROUTER_API_KEY` (optional) |
| Google Search Console / GA4 | your own Google OAuth client + `BETTER_AUTH_SECRET` (optional, free) |

## Stack

Vite + TanStack Start (React) running on the Cloudflare Workers runtime (`workerd` locally via Docker), SQLite (D1) for storage, Drizzle migrations, an MCP server at `/mcp`.

## License

MIT — see [LICENSE](LICENSE).
