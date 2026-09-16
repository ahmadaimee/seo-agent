---
name: seo-audit
description: "Full website SEO audit with parallel subagent delegation. Crawls up to 500 pages, detects business type, delegates to up to 15 specialists, scores health 0-100, and delivers either an expert report or a one-page plain-language report built around a single do-this-week action. Use when user says audit, full SEO check, analyze my site, or website health check."
user-invocable: true
argument-hint: "[url]"
license: MIT
metadata:
  author: ahmadaimee
  version: "3.0.0"
  category: seo
---

# Full Website SEO Audit

## Process

0. **Read project context** (when the S.E.O Agent MCP is connected): resolve `projectId`
   with `list_projects` / `create_project`, call `get_project_context`, and ground the audit
   in `business_overview` -- what the business does decides which findings matter. If that
   section is empty, infer it from the site and confirm in one question before continuing.
   See `docs/PROJECT-CONTEXT.md`. Skip this step entirely when the MCP is not connected.
1. **Render homepage**: use `"${CLAUDE_PLUGIN_ROOT}/scripts/claude-seo" run render_page.py <url> --mode auto --json` to capture raw HTML, rendered HTML, extracted text, SPA status, and accessibility data when needed
2. **Detect business type**: analyze homepage signals per seo orchestrator
3. **Crawl site**: follow internal links up to 500 pages, respect robots.txt
4. **Delegate to subagents** (if available, otherwise run inline sequentially):
   - `seo-technical` -- robots.txt, sitemaps, canonicals, Core Web Vitals, security headers
   - `seo-content` -- E-E-A-T, readability, thin content, AI citation readiness
   - `seo-schema` -- detection, validation, generation recommendations
   - `seo-sitemap` -- structure analysis, quality gates, missing pages
   - `seo-performance` -- LCP, INP, CLS measurements
   - `seo-visual` -- screenshots, mobile testing, above-fold analysis
   - `seo-geo` -- AI crawler access, llms.txt, citability, brand mention signals
   - `seo-local` -- GBP signals, NAP consistency, reviews, local schema, industry-specific local factors (spawn when Local Service industry detected: brick-and-mortar, SAB, or hybrid business type)
   - `seo-maps` -- Geo-grid rank tracking, GBP audit, review intelligence, competitor radius mapping (spawn when Local Service detected AND DataForSEO MCP available)
   - `seo-google` -- CWV field data (CrUX), URL indexation (GSC), organic traffic (GA4) (spawn when Google API credentials detected via `"${CLAUDE_PLUGIN_ROOT}/scripts/claude-seo" run google_auth.py --check`)
   - `seo-backlinks` -- Backlink profile data: DA/PA, referring domains, anchor text, toxic links (spawn when Moz or Bing API credentials detected via `"${CLAUDE_PLUGIN_ROOT}/scripts/claude-seo" run backlinks_auth.py --check`, or always include Common Crawl domain-level metrics)
   - `seo-cluster` -- Semantic clustering analysis (spawn when content strategy signals detected: blog, pillar pages, topic clusters)
   - `seo-sxo` -- Search experience analysis: page-type mismatch, user stories, persona scoring (always include in full audits)
   - `seo-drift` -- Drift analysis: compare against stored baseline (spawn when drift baseline exists for the URL via `"${CLAUDE_PLUGIN_ROOT}/scripts/claude-seo" run drift_history.py <url>`)
   - `seo-ecommerce` -- Product schema, marketplace intelligence (spawn when E-commerce industry detected)
5. **Propose a starting focus area** (only when the S.E.O Agent MCP is connected and the
   site is alive): one `research_keywords` call seeded from the site's actual topic, then
   pick one theme and 3 to 5 specific, low-difficulty keywords the site can realistically
   rank for, each with the page or post to make. This is a direction, not a keyword
   strategy -- hand off to `seo-keywords` for the full workflow. Skip it when the site is down.
6. **Score** -- aggregate into SEO Health Score (0-100)
7. **Persist audit artifacts** -- write all outputs under `{domain}-audit/`
8. **Report** -- generate prioritized action plan and optional PDF/HTML report

## Crawl Configuration

```
Max pages: 500
Respect robots.txt: Yes
Follow redirects: Yes (max 3 hops)
Timeout per page: 30 seconds
Concurrent requests: 5
Delay between requests: 1 second
```

## Output Files

- `{domain}-audit/FULL-AUDIT-REPORT.md`: Comprehensive findings
- `{domain}-audit/ACTION-PLAN.md`: Prioritized recommendations (Critical > High > Medium > Low)
- `{domain}-audit/audit-data.json`: Structured audit envelope for report generation
- `{domain}-audit/findings/*.md`: Per-category specialist findings (`technical.md`, `content.md`, `schema.md`, `performance.md`, `visual.md`, etc.)
- `{domain}-audit/screenshots/`: Desktop + mobile captures (if Playwright available)
- **PDF Report** (recommended): Generate a professional A4 PDF using `"${CLAUDE_PLUGIN_ROOT}/scripts/claude-seo" run google_report.py --type full --data {domain}-audit/audit-data.json --domain <domain> --output-dir {domain}-audit/`. This produces a white-cover enterprise report with TOC, executive summary, charts (Lighthouse gauges, query bars, index donut), metric cards, threshold tables, prioritized recommendations with effort estimates, and implementation roadmap. Always offer PDF generation after completing an audit.

## Structured Audit Data Envelope

Write `{domain}-audit/audit-data.json` with this shape so `"${CLAUDE_PLUGIN_ROOT}/scripts/claude-seo" run google_report.py --type full --data {domain}-audit/audit-data.json --domain <domain> --output-dir {domain}-audit/` can generate a report even when Google API data is unavailable:

```json
{
  "summary": {
    "health_score": 0,
    "business_type": "detected type",
    "top_findings": [],
    "quick_wins": []
  },
  "categories": [
    {
      "name": "Technical SEO",
      "score": 0,
      "what_works": [],
      "findings": [
        {
          "title": "Finding title",
          "severity": "Critical|High|Medium|Low|Info",
          "description": "Evidence-backed detail",
          "recommendation": "Specific fix"
        }
      ]
    }
  ],
  "action_plan": {
    "phases": [
      {"name": "Phase 1: Critical Fixes", "timeframe": "Week 1", "items": []},
      {"name": "Phase 2: High-Impact Improvements", "timeframe": "Weeks 2-3", "items": []},
      {"name": "Phase 3: Content & Authority", "timeframe": "Month 2", "items": []},
      {"name": "Phase 4: Monitoring & Iteration", "timeframe": "Ongoing", "items": []}
    ]
  },
  "artifacts": {
    "findings_dir": "findings/",
    "screenshots_dir": "screenshots/"
  }
}
```

## Scoring Weights

| Category | Weight |
|----------|--------|
| Technical SEO | 22% |
| Content Quality | 23% |
| On-Page SEO | 20% |
| Schema / Structured Data | 10% |
| Performance (CWV) | 10% |
| AI Search Readiness | 10% |
| Images | 5% |

## Report Structure

### Executive Summary
- Overall SEO Health Score (0-100)
- Business type detected
- Top 5 critical issues
- Top 5 quick wins

### Technical SEO
- Crawlability issues
- Indexability problems
- Security concerns
- Core Web Vitals status

### Content Quality
- E-E-A-T assessment
- Thin content pages
- Duplicate content issues
- Readability scores

### On-Page SEO
- Title tag issues
- Meta description problems
- Heading structure
- Internal linking gaps

### Schema & Structured Data
- Current implementation
- Validation errors
- Missing opportunities

### Performance
- LCP, INP, CLS scores
- Resource optimization needs
- Third-party script impact

### Images
- Missing alt text
- Oversized images
- Format recommendations

### AI Search Readiness
- Citability score
- Structural improvements
- Authority signals

## Priority Definitions

- **Critical**: Blocks indexing or causes penalties (fix immediately)
- **High**: Significantly impacts rankings (fix within 1 week)
- **Medium**: Optimization opportunity (fix within 1 month)
- **Low**: Nice to have (backlog)

## DataForSEO Integration (Optional)

If DataForSEO MCP tools are available, spawn the `seo-dataforseo` agent alongside existing subagents to enrich the audit with live data: real SERP positions, backlink profiles with spam scores, on-page analysis (Lighthouse), business listings, and AI visibility checks (ChatGPT scraper, LLM mentions).

## Google API Integration (Optional)

If Google API credentials are configured (`"${CLAUDE_PLUGIN_ROOT}/scripts/claude-seo" run google_auth.py --check`), spawn the `seo-google` agent to enrich the audit with real Google field data: CrUX Core Web Vitals (replaces lab-only estimates), GSC URL indexation status, search performance (clicks, impressions, CTR), and GA4 organic traffic trends. The Performance (CWV) category score benefits most from field data.

## S.E.O Agent MCP Integration (Optional)

When the S.E.O Agent MCP server is connected it supplies the data the bundled
Python toolchain cannot produce on its own: keyword volume and difficulty, live
SERPs, third-party backlink and domain estimates, Maps grids, and the shared
project memory. It is DataForSEO-backed, so calls cost credits.

Run `whoami` first to confirm the connection and the remaining credit balance
before spending anything. Then keep the spend modest for one audit:

| Tool | Use in an audit | Cost |
| --- | --- | --- |
| `get_project_context` / `update_project_context` | read the business, write findings back | free |
| `whoami`, `list_projects`, `create_project` | connect and resolve the project | free |
| `get_backlinks_overview` | referring-domain picture; usually decides the "one thing" | paid |
| `get_domain_overview` | estimated organic traffic and keyword count; skip when the site is dead | paid |
| `research_keywords` | one call, 1-3 seeds, to propose a starting focus area | paid |
| `run_site_audit` / `get_audit_status` / `get_audit_issues` | second-opinion crawl; **not** a replacement for the local crawl, which is free and deeper | paid |

Check the research log before buying: if the same research ran within the last 30
days, reuse it and say so. On finish, write back a corrected `business_overview`,
the pages the report singles out via `addKeyPages`, and a research log entry:
`{ appendResearchLog: { summary: "Site audit: <domain>. Verdict: <conclusion>" } }`.

Precedence when several data paths are available: the S.E.O Agent MCP first (it
carries project context, the research log and credit reuse), then the DataForSEO
extension for merchant and marketplace data the MCP does not expose, then the
free sources (Moz, Bing Webmaster, Common Crawl, CrUX, Search Console).

## Report Modes

Ask which is wanted when it is not obvious from the request. Default to expert.

### Expert report (default)

`FULL-AUDIT-REPORT.md` + `ACTION-PLAN.md` + `findings/*.md` as described above.
Written for someone who already does SEO: every finding carries its evidence,
severity and fix, and the action plan is phased.

### One-page report (`beginner`, or when the audience is the site owner)

One shareable HTML page that a complete beginner can read once and act on. Use
`template.html` in this skill directory: fill in the content and keep the CSS and
structure as they are (light palette only, no dark mode).

The whole page exists to support ONE action the owner can take this week.
Everything else is supporting detail.

- Header: domain as the title, the review date on its own line under it, then a
  2-3 sentence summary (overall state; the main gap and the one thing; what the
  report covers).
- Section order: verdict, the one thing, small fixes (5 to 10 max, ordered by
  impact), where to focus first (healthy sites only), already working, method footer.
- Each fix row shows exact evidence (a quoted tag or number) and steps a
  non-technical person can follow.
- "Where to focus first" names one topic area and 3 to 5 low-difficulty keywords,
  each with its search volume in plain words and the page or post to make. Omit
  the section when the site is down.

Derive the one thing from the data, never from generic advice. Common patterns:

- Clean site, no backlinks: outreach to guests, partners or directories, with a
  ready-to-send message.
- Dead domain with a live successor site: permanent redirect via hosting support,
  with the exact sentence to send them.
- Blocked or noindexed pages: remove the block.

It must be doable this week by a non-technical person, with copy-paste-ready
mechanics included.

Deliver it: if the environment can publish or preview HTML (for example as an
artifact), do that; otherwise save the file and tell the user to open it.

### Guardrails for the one-page report

- Tone: calm and plain. No exclamation points, no drama words, no em dashes, no
  "Not X. Y." contrasts, no filler. Severity words only where literally true -- a
  down site is critical, a long title is not.
- Gloss every term of art in plain English on first use: canonical, meta
  description, alt text, crawler, 301, structured data.
- Skip nitpicks that do not matter for this site. A beginner report with twenty
  findings has failed.
- Missing backlink or ranking data means "no recorded data", not a penalty.
- Favor keywords the site can win now: specific intent, low difficulty. Do not
  list head terms a new site cannot rank for yet.
- Separate what the tools reported from what you verified yourself, and note both
  in the method footer.

## Verification (both modes)

1. Verify every finding you plan to report against the live page HTML. Report
   nothing you have not seen evidence for.
2. If a crawl comes back broken or nearly empty (certificate errors, 5xx, one page
   crawled), investigate before writing. Check the certificate and redirect
   variants yourself, and search the web for the business. A dead domain often has
   a live successor site, which flips the whole recommendation to "redirect the
   old domain".
3. Review before delivering: run an adversarial pass with a second agent or model
   when the environment has one, otherwise do a fresh self-review. Have the
   reviewer attack four things: claims beyond the facts, unglossed jargon,
   anything overwhelming for the audience, and dramatic language. The reviewer may
   also flag true facts it was not given; check those against your evidence
   instead of "fixing" them.

## Error Handling

| Scenario | Action |
|----------|--------|
| URL unreachable (DNS failure, connection refused) | Report the error clearly. Do not guess site content. Suggest the user verify the URL and try again. |
| robots.txt blocks crawling | Report which paths are blocked. Analyze only accessible pages and note the limitation in the report. |
| Rate limiting (429 responses) | Back off and reduce concurrent requests. Report partial results with a note on which sections could not be completed. |
| Timeout on large sites (500+ pages) | Cap the crawl at the timeout limit. Report findings for pages crawled and estimate total site scope. |
| S.E.O Agent MCP not connected | Run the full local audit anyway -- crawling, rendering, technical, schema, content, images and the free backlink sources all work without it. Note in the report which sections were skipped (keyword volume, SERP positions, third-party backlink estimates, Maps grid). |
| Subagent hits its `maxTurns` budget on a large site | Findings are not lost: every audit subagent writes a partial `output_dir/findings/*.md` after its first analysis pass and overwrites it with the complete findings before finishing. Read whatever findings file exists and merge it into the report, noting it may be partial. |
