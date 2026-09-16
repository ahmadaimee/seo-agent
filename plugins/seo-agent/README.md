# S.E.O Agent (self-hosted, free)

SEO data and guided workflows for your AI agent — running on your own machine. No S.E.O Agent account, no subscription, no hosted service. The only cost is DataForSEO, which you pay directly per API call.

## What you can do

- Find and evaluate keywords
- Research competitors and content gaps
- Audit a website and prioritize fixes
- Analyze backlinks and find link prospects
- Track organic and Google Maps rankings
- Work with Google Search Console and Analytics data

The plugin includes nine skills that guide the agent through complete SEO workflows, plus the MCP server of your local S.E.O Agent instance for live data and project management.

## Connect

1. Run S.E.O Agent (from the repository root):

   ```bash
   cp .env.example .env.local  # set DATAFORSEO_API_KEY
   pnpm install --frozen-lockfile
   pnpm run db:migrate:local
   pnpm dev
   ```

   The app is at `http://localhost:3001` and the MCP server at `http://localhost:3001/mcp`. Auth is disabled (`AUTH_MODE=local_noauth`) — keep it bound to localhost or behind your own auth. To run it on a server instead, see the Railway guide in the repository docs.

2. Install this plugin in Claude Code:

   ```
   /plugin marketplace add ahmadaimee/seo-agent
   /plugin install seo-agent@seo-agent
   ```

   The plugin's MCP entry already points at `http://localhost:3010/mcp`. Change the port in `.claude-plugin/plugin.json` and `.env` (`PORT=`) if you run it elsewhere.

## Try it

- "Research keywords for my website and shortlist the best opportunities."
- "Audit my website and tell me what to fix first."
- "What does competitor.com rank for that I don't?"
- "Which pages are close to ranking in Google Search Console?"
- "Track my rankings for these keywords and summarize what changed."

## Included skills

- Competitive landscape
- Competitor analysis
- Keyword clustering
- Keyword research
- Link prospecting
- Local SEO
- SEO audit
- SEO coach
- SEO project setup

## Upstream

Based on [ahmadaimee/seo-agent](https://github.com/ahmadaimee/seo-agent) (MIT). This fork removes the hosted-service defaults and telemetry.
