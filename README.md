# S.E.O Agent

Free, self-hosted SEO data and workflows for AI agents — keyword research, rank tracking, competitor insights, backlinks, site audits and AI visibility, exposed to Claude Code (and any MCP client) through an MCP server plus nine ready-made skills.

No account, no subscription, no telemetry. You run it, you own the data. The only external cost is DataForSEO, billed to you directly per API call.

## Run it

Deploy to [Railway](https://railway.com): point a new service at this repo, mount a volume at `/app/.wrangler`, and set `DATAFORSEO_API_KEY`. `railway.json` handles the rest (it builds `Dockerfile.selfhost` and health-checks `/api/health`). Full walkthrough, including putting it on your own domain: [Railway self-hosting](docs/SELF_HOSTING_RAILWAY.md).

To work on the code instead, run it directly:

```bash
cp .env.example .env.local    # set DATAFORSEO_API_KEY (base64 of login:password)
pnpm install --frozen-lockfile
pnpm run db:migrate:local
pnpm dev
```

App: `http://localhost:3001` · MCP server: `http://localhost:3001/mcp`

Auth is disabled (`AUTH_MODE=local_noauth`). Any deployment reachable from the internet should set `SELFHOST_BASIC_AUTH_USER` and `SELFHOST_BASIC_AUTH_PASSWORD`, which put HTTP Basic auth in front of everything except `/api/health` and shared audit reports.

Docs: [Railway self-hosting](docs/SELF_HOSTING_RAILWAY.md) · [DataForSEO key](docs/DATAFORSEO_API_KEY.md) · [Google Search Console](docs/SELF_HOSTING_GOOGLE_SEARCH_CONSOLE.md) · [Local development](docs/LOCAL_DEVELOPMENT.md)

## Site audits

Crawl up to 500 pages and get back a prioritized list of what to fix. Alongside the usual technical checks (titles, meta descriptions, headings, canonicals, duplicates, broken links, orphans, redirect chains, thin content, Core Web Vitals via Lighthouse), each audit checks:

- **Site files** — `robots.txt` (a 5xx there stops Google crawling, so it is reported as critical; a 404 is not), an XML sitemap and whether `robots.txt` declares it, and `llms.txt`
- **Favicon** — declared, reachable, and in a format Google Search actually reads (it does not read SVG)
- **Social previews** — `og:image` present, absolute, large enough, and reachable
- **Measurement tags** — Google Analytics / Tag Manager, Search Console and Bing Webmaster verification tags in the served HTML
- **Screenshots** — how the page rendered on mobile and desktop, captured during the Lighthouse run

### Share a report

Any finished audit can be published as a read-only link (`/r/<token>`), optionally behind a password. The recipient needs no account and can filter and sort the report but cannot change anything or reach the rest of the workspace. Links are revocable, and creating a new one retires the old.

## Use it from Claude Code

```
/plugin marketplace add ahmadaimee/seo-agent
/plugin install seo-agent@seo-agent
```

The plugin's MCP entry defaults to `http://localhost:3001/mcp`. For a Railway (or any remote) instance set two environment variables on your machine:

- `SEO_AGENT_MCP_URL` — e.g. `https://your-host/mcp`
- `SEO_AGENT_MCP_AUTH` — e.g. `Basic <base64 user:password>` when Basic auth is on

Skills: `/seo-project-setup`, `/keyword-research`, `/keyword-clustering`, `/competitor-analysis`, `/competitive-landscape`, `/seo-audit`, `/local-seo`, `/link-prospecting`, `/seo-coach`.

## What needs a key

| Feature                                                                       | Needs                                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Keywords, SERPs, backlinks, rank tracking, audits (Lighthouse), AI visibility | `DATAFORSEO_API_KEY`                                                 |
| SAM, the in-app chat agent                                                    | `OPENROUTER_API_KEY` (optional)                                      |
| Google Search Console / GA4                                                   | your own Google OAuth client + `BETTER_AUTH_SECRET` (optional, free) |

Nothing is sent anywhere else. There is no usage heartbeat, no call counter and no phone-home; the telemetry the upstream project shipped was removed at the source.

## Stack

Vite + TanStack Start (React) running on the Cloudflare Workers runtime (`workerd`), SQLite (D1) for storage, Drizzle migrations, an MCP server at `/mcp`. Deployed as a container image (`Dockerfile.selfhost`) on Railway.

## License

MIT — see [LICENSE](LICENSE).
