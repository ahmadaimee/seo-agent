# Shared project context

Every skill in this plugin reads and writes one shared memory: the S.E.O Agent
project context. It survives new sessions, new machines and new agents, and the
user can read and edit it on the project's Context settings page in the app.

The project-context tools are **free** — they spend no DataForSEO credits.

## The contract

1. **Read first.** Call `get_project_context(projectId)` before doing research.
   Resolve `projectId` with `list_projects` (or `create_project`) when it is not
   known. Ground the work in what is already there: the business, the goal, the
   positioning, the saved competitors and the key pages decide which findings
   matter.

2. **Fill only what you need.** Each skill declares the sections it depends on.
   If one is empty, run a minimal inline setup — infer it from the site and
   confirm in a single question — write it back, then continue. Never front-load
   the full interview; point at `seo-project-setup` at the end for the rest.

3. **Check the research log before spending.** If the same research ran within
   the last 30 days, reuse it and say so instead of re-buying it.

4. **Write back what is durable.** On finish, call `update_project_context` with
   the patch ops below, and append a research log entry whenever the session
   spent credits:
   `{ appendResearchLog: { summary: "<what>: <inputs>. Verdict: <conclusion>" } }`

## Patch ops

| Op | Use for |
| --- | --- |
| `{ section: "business_overview", content }` | what the business does, who it is for, markets, site stage |
| `{ section: "current_goal", content }` | the goal with a metric and a timeframe |
| `{ section: "positioning", content }` | audience, problem, differentiator, claims to defend |
| `{ section: "writing_preferences", content }` | voice, banned words, topics to avoid |
| `{ addCompetitors: [{ domain, name?, notes? }] }` | confirmed search competitors |
| `{ removeCompetitors: [...] }` | entries **you** added that proved irrelevant (leave the user's rows alone) |
| `{ addKeyPages: [{ url, role: "hub"\|"spoke"\|"money"\|"other", topic?, notes? }] }` | money pages, hubs, linkable assets |
| `{ customSection: "<slug>", title?, content }` | anything that does not fit a typed section |
| `{ appendResearchLog: { summary } }` | every credit-spending session |

Sections are prose (~4,000 characters). Write a few tight paragraphs, not a
transcript. Overwriting a section replaces it — merge new answers into the
existing prose instead of discarding it.

## When the MCP is not connected

Every skill in this plugin works without the S.E.O Agent MCP server; the bundled
Python toolchain covers crawling, rendering, technical analysis, schema, content,
images and the free backlink sources. Without the MCP you lose keyword volume and
difficulty, SERP data, rank tracking, Maps grids and the shared memory above.

Do not stall. Run the local analysis, and note in the output which sections were
skipped for lack of a data source.
