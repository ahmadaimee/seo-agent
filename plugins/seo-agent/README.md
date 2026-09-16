# S.E.O Agent (self-hosted, free)

Complete SEO for your AI agent: **31 skills** and **18 sub-agents**, running on
your own machine. No S.E.O Agent account, no subscription, no telemetry. The only
external cost is DataForSEO, which you pay directly per API call.

## Two halves, one plugin

**Runs locally, free, no account.** A bundled Python toolchain with its own
isolated environment and headless Chromium: crawling up to 500 pages, rendering
SPAs, technical SEO, schema, content quality, images, sitemaps, Core Web Vitals,
AI-search readiness, drift monitoring, and the free backlink sources (Common
Crawl, Moz, Bing Webmaster).

**Needs your S.E.O Agent instance.** Keyword volume and difficulty, live SERPs,
rank tracking, Maps rank grids, competitor and backlink estimates, and the shared
project context every skill reads and writes. DataForSEO-backed, so these calls
cost credits.

Every command degrades gracefully. Without the MCP server connected you still get
the entire local analysis; the output names the sections it had to skip.

## Setup

1. **Run S.E.O Agent locally** (from the repository root):

   ```bash
   cp .env.example .env        # set DATAFORSEO_API_KEY
   docker compose up -d --build
   ```

   The app is at `http://localhost:3010` and the MCP server at
   `http://localhost:3010/mcp`. Auth is disabled (`AUTH_MODE=local_noauth`) —
   keep it bound to localhost or behind your own auth.

2. **Install the plugin** in Claude Code:

   ```
   /plugin marketplace add ahmadaimee/seo-agent
   /plugin install seo-agent@seo-agent
   ```

3. **Build the local toolchain** (one time, creates an isolated Python
   environment and downloads Chromium; nothing is added to your global Python or
   PATH):

   ```
   /seo setup
   ```

   Check it any time with `/seo doctor`. Requires Python 3.10 or newer.

For a hosted instance, set `SEO_AGENT_MCP_URL` and, when Basic auth is on,
`SEO_AGENT_MCP_AUTH` (`Basic <base64 user:password>`) in your environment.

## Commands

`/seo` is the orchestrator. Every sub-skill is also directly invocable.

| Command                                       | What it does                                                                                     | Data      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------- |
| `/seo audit <url>`                            | Full site audit, up to 15 specialists in parallel, health score 0-100, expert or one-page report | local     |
| `/seo page <url>`                             | Deep single-page analysis                                                                        | local     |
| `/seo technical <url>`                        | Crawlability, indexability, security, Core Web Vitals, JS rendering                              | local     |
| `/seo content <url>`                          | E-E-A-T, readability, thin content, AI citation readiness                                        | local     |
| `/seo content-brief <topic>`                  | Competitive content brief with outline and internal links                                        | local     |
| `/seo schema <url>`                           | Detect, validate and generate Schema.org markup                                                  | local     |
| `/seo sitemap <url>`                          | Analyze or generate XML sitemaps                                                                 | local     |
| `/seo images <url>`                           | Alt text, formats, sizes, CLS, image SERP                                                        | local     |
| `/seo geo <url>`                              | AI Overviews, ChatGPT and Perplexity readiness                                                   | local     |
| `/seo sxo <url>`                              | Why a well-optimized page still does not rank                                                    | local     |
| `/seo hreflang <url>`                         | International SEO audit and generation                                                           | local     |
| `/seo drift baseline\|compare\|history <url>` | Catch SEO regressions after a deploy                                                             | local     |
| `/seo ecommerce <url>`                        | Product schema and marketplace visibility                                                        | local     |
| `/seo programmatic <url>`                     | Pages generated at scale, thin-content safeguards                                                | local     |
| `/seo google <command> <url>`                 | Your own Search Console, PageSpeed, CrUX, GA4                                                    | your data |
| `/seo backlinks <url>`                        | Link profile: Moz, Bing, Common Crawl, then MCP                                                  | mixed     |
| `/seo keywords <seed>`                        | Volume, difficulty, intent, SERPs, rank tracking                                                 | MCP       |
| `/seo cluster <seed>`                         | SERP-overlap and intent clustering, keyword-to-page mapping, cannibalization                     | mixed     |
| `/seo competitor <domain>`                    | One competitor's footprint, keywords, themes, gaps                                               | MCP       |
| `/seo landscape <topic>`                      | Who wins the market and where the openings are                                                   | MCP       |
| `/seo link-prospecting <url>`                 | Prospects, contact paths, outreach drafts                                                        | MCP       |
| `/seo local <url>`                            | Google Business Profile, NAP, citations, reviews, local schema                                   | mixed     |
| `/seo maps <command>`                         | Geo-grid rank tracking, GBP audit, competitor radius                                             | MCP       |
| `/seo plan <business-type>`                   | Strategic SEO plan                                                                               | local     |
| `/seo competitor-pages <url>`                 | Generate comparison and alternatives pages                                                       | local     |
| `/seo flow <stage> <url>`                     | FLOW framework prompts (Find, Leverage, Optimize, Win)                                           | local     |
| `/seo project-setup`                          | One interview that fills the shared project context                                              | MCP       |
| `/seo coach`                                  | Beginner-friendly coach mode                                                                     | —         |
| `/seo setup` · `/seo doctor`                  | Build or check the local Python runtime                                                          | —         |

## Shared project context

The business, the goal, the positioning, the competitors and the key pages live
in the project's shared context, not in a local file. Every skill reads it before
working and writes back what is durable, so the knowledge follows you across
sessions, machines and agents, and you can edit it on the project's Context page
in the app. The context tools are free. See [docs/PROJECT-CONTEXT.md](docs/PROJECT-CONTEXT.md).

## Data source precedence

1. **Your own data** — Search Console and GA4. Free, first-party, beats any estimate.
2. **The local toolchain** — crawling, rendering, schema, content, images. Free.
3. **S.E.O Agent MCP** — keyword metrics, SERPs, rank tracking, Maps grids. Paid
   per call: `whoami` shows the credit balance, and the research log stops the
   same research being bought twice within 30 days.
4. **Optional extensions** — DataForSEO direct, Firecrawl, Ahrefs, SE Ranking,
   Profound, Bing Webmaster, Unlighthouse, Banana. Each ships in `extensions/`
   with its own installer; use them for what the MCP does not expose, such as
   merchant data for `/seo ecommerce`.

Estimates are never presented as measured data. A gap is reported as `unknown`
with the source that would fill it.

## Try it

- "Audit my website and tell me what to fix first."
- "Give me a one-page SEO report I can send to the owner."
- "Research keywords for my site and shortlist the best opportunities."
- "Map my Search Console queries to pages and find cannibalization."
- "What does competitor.com rank for that I don't?"
- "Why isn't my service page ranking?"
- "Check my Google Business Profile against local competitors."

## Layout

```
plugins/seo-agent/
  skills/        31 skills (generated from .agents/skills by pnpm sync-plugin-skills)
  agents/        18 sub-agents for parallel audit work
  scripts/       bundled Python toolchain + the claude-seo launcher
  hooks/         PostToolUse schema validation
  extensions/    8 optional MCP extensions
  tests/         Python test suite for the toolchain
  docs/          project context and integration notes
```

Skills are edited in `.agents/skills/` and synced with
`pnpm sync-plugin-skills`; CI fails on drift. Everything else in the plugin is
edited in place.

## License

MIT. The bundled SEO toolchain derives from
[claude-seo](https://github.com/ahmadaimee/claude-seo) (MIT); the FLOW prompt
library under `skills/seo-flow/references/` is CC BY 4.0 and keeps its original
attribution.
