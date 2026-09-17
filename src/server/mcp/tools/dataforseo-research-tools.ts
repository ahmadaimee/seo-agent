/* eslint-disable max-lines */
import { sort } from "remeda";
import { z } from "zod";
import {
  createDataforseoClient,
  fetchKeywordMetricsForList,
  type KeywordMetricRow,
} from "@/server/lib/dataforseo";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  formatMcpTable,
  readPath,
  type McpTableColumn,
} from "@/server/mcp/table";
import { pushAnd } from "@/server/mcp/tools/local-seo-shared";
import { resolveLabsMarket, resolveMarket } from "@/shared/keyword-locations";
import {
  assertLabsLocationCode,
  assertLanguageForLocation,
} from "@/server/lib/market";
import {
  DEFAULT_LOCATION_CODE,
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import { assertFilterConditionBudget } from "@/server/lib/dataforseo/filters";
import {
  buildRankedKeywordsScopeFilter,
  type ScopeFilter,
} from "@/server/lib/dataforseo/researchScopeFilters";
import { parseResearchTargetOrThrow } from "@/server/lib/domainUtils";
import {
  RESEARCH_SCOPE_PARAM_DESCRIPTION,
  researchScopeSchema,
} from "@/shared/researchScope";

const rankedResultTypeSchema = z.enum([
  "organic",
  "paid",
  "featured_snippet",
  "local_pack",
  "ai_overview_reference",
]);

const serpCompetitorResultTypeSchema = z.enum([
  "organic",
  "paid",
  "featured_snippet",
  "local_pack",
]);

const marketSchema = z
  .object({
    country: z
      .enum(["US", "USA", "United States", "United States of America"])
      .optional()
      .describe(
        "Country selector. Only the United States can be selected explicitly.",
      ),
  })
  .optional()
  .describe(
    "Legacy US selector. Prefer locationCode/languageCode for any Labs market. Explicit locationCode takes precedence; otherwise omitted = the project's default market.",
  );

const domainTargetSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      /^(?!https?:\/\/)(?!www\.)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(
        value,
      ),
    "Use a domain or subdomain without protocol and without www.",
  );

const rankedTargetSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      /^https?:\/\/\S+$/.test(value) ||
      domainTargetSchema.safeParse(value).success,
    "Use a domain without protocol/www or an absolute page URL.",
  );

const getRankedKeywordsInputSchema = {
  projectId: projectIdSchema,
  target: rankedTargetSchema.describe(
    "Domain (no protocol/www) or absolute page URL to list ranked keywords for.",
  ),
  scope: researchScopeSchema
    .optional()
    .describe(RESEARCH_SCOPE_PARAM_DESCRIPTION),
  market: marketSchema,
  locationCode: locationCodeSchema
    .optional()
    .describe(
      "Country-level DataForSEO Labs location code. Defaults to the project's market; takes precedence over the legacy market object.",
    ),
  languageCode: languageCodeSchema
    .optional()
    .describe(
      "Language for locationCode. Defaults to that location's primary language when locationCode overrides the project market.",
    ),
  resultTypes: z
    .array(rankedResultTypeSchema)
    .min(1)
    .max(5)
    .optional()
    .describe("SERP result types to include. Defaults to organic and paid."),
  includeSubdomains: z
    .boolean()
    .optional()
    .describe("Deprecated: use scope ('subdomains' or 'domain') instead."),
  minSearchVolume: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only return keywords with at least this monthly search volume."),
  maxRank: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Only return keywords ranking at this position or better."),
  excludeBrandTerms: z
    .array(z.string().min(1).max(80))
    .min(1)
    .max(10)
    .optional()
    .describe("Exclude keywords containing any of these brand terms."),
  sortBy: z
    .enum(["rank", "search_volume", "traffic_estimate", "cpc"])
    .optional()
    .describe("Sort order for returned rows. Defaults to search_volume."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum rows to return (1-100). Defaults to 50."),
  offset: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Rows to skip for pagination."),
} as const;

const findSerpCompetitorsInputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(100)
    .describe("Keywords whose SERPs are compared (1-100)."),
  market: marketSchema,
  locationCode: locationCodeSchema
    .optional()
    .describe(
      "Country-level DataForSEO Labs location code. Defaults to the project's market; takes precedence over the legacy market object.",
    ),
  languageCode: languageCodeSchema
    .optional()
    .describe(
      "Language for locationCode. Defaults to that location's primary language when locationCode overrides the project market.",
    ),
  resultTypes: z
    .array(serpCompetitorResultTypeSchema)
    .min(1)
    .max(4)
    .optional()
    .describe(
      "SERP result types to include. Defaults to organic and local_pack.",
    ),
  excludeDomains: z
    .array(domainTargetSchema)
    .min(1)
    .max(50)
    .optional()
    .describe("Domains to exclude from results (e.g. the user's own site)."),
  includeSubdomains: z
    .boolean()
    .optional()
    .describe("Count subdomains as part of the same competitor domain."),
  sortBy: z
    .enum(["visibility", "traffic_estimate", "avg_position", "keyword_count"])
    .optional()
    .describe("Sort order for returned competitors. Defaults to visibility."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum competitors to return (1-100). Defaults to 50."),
  offset: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Rows to skip for pagination."),
} as const;

const keywordMetricsSortSchema = z.enum([
  "search_volume",
  "keyword_difficulty",
  "cpc",
  "competition",
]);

const getKeywordMetricsInputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string().min(1).max(80))
    .min(1)
    .max(700)
    .describe("Keywords to fetch metrics for (1-700)."),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
  includeMonthlyTrends: z
    .boolean()
    .optional()
    .describe("Include monthly search-volume trend rows. Defaults to true."),
  includeClickstreamData: z
    .boolean()
    .optional()
    .describe(
      "Refine search volumes with clickstream data, which disaggregates Google Ads' grouped close-variant volumes (plurals/misspellings). DOUBLES the credit cost of the call. Default false. No effect for countries served from Google Ads data.",
    ),
  sortBy: keywordMetricsSortSchema
    .optional()
    .describe("Sort order for returned rows. Defaults to search_volume."),
} as const;

type Market = z.infer<typeof marketSchema>;
type GetRankedKeywordsArgs = z.infer<
  z.ZodObject<typeof getRankedKeywordsInputSchema>
>;
type FindSerpCompetitorsArgs = z.infer<
  z.ZodObject<typeof findSerpCompetitorsInputSchema>
>;
type GetKeywordMetricsArgs = z.infer<
  z.ZodObject<typeof getKeywordMetricsInputSchema>
>;
/**
 * Resolves a Labs location + language. Explicit location/language fields win,
 * followed by the legacy explicit-US selector; omitted fields inherit the
 * project's default via resolveLabsMarket, which keeps these Labs-only tools
 * off an Ads-served project market. Validate before starting a paid request.
 */
function resolveMarketSelector(
  selector: {
    market?: Market;
    locationCode?: number;
    languageCode?: string;
  },
  project: { locationCode: number; languageCode: string },
): { locationCode: number; languageCode: string } {
  let resolved: { locationCode: number; languageCode: string };
  if (selector.locationCode != null || selector.languageCode != null) {
    resolved = resolveLabsMarket(
      {
        locationCode: selector.locationCode,
        languageCode: selector.languageCode,
      },
      project,
    );
  } else if (selector.market?.country != null) {
    // The Zod enum already restricts explicit values to United States variants.
    resolved = { locationCode: DEFAULT_LOCATION_CODE, languageCode: "en" };
  } else {
    resolved = resolveLabsMarket({}, project);
  }
  assertLabsLocationCode(resolved.locationCode);
  assertLanguageForLocation(resolved.locationCode, resolved.languageCode);
  return resolved;
}

function sortOrderByRankedMode(
  sortBy: GetRankedKeywordsArgs["sortBy"] = "search_volume",
): string[] {
  switch (sortBy) {
    case "rank":
      return ["ranked_serp_element.serp_item.rank_absolute,asc"];
    case "traffic_estimate":
      return ["ranked_serp_element.serp_item.etv,desc"];
    case "cpc":
      return ["keyword_data.keyword_info.cpc,desc"];
    case "search_volume":
      return ["keyword_data.keyword_info.search_volume,desc"];
  }
}

function buildRankedKeywordFilters(
  args: {
    minSearchVolume?: number;
    maxRank?: number;
    excludeBrandTerms?: string[];
  },
  scopeFilter?: ScopeFilter,
) {
  const filters: unknown[] = [];
  let conditionCount = 0;
  if (scopeFilter) {
    for (const clause of scopeFilter.clauses) pushAnd(filters, clause);
    conditionCount += scopeFilter.conditionCount;
  }
  if (args.minSearchVolume != null) {
    pushAnd(filters, [
      "keyword_data.keyword_info.search_volume",
      ">=",
      args.minSearchVolume,
    ]);
    conditionCount += 1;
  }
  if (args.maxRank != null) {
    pushAnd(filters, [
      "ranked_serp_element.serp_item.rank_absolute",
      "<=",
      args.maxRank,
    ]);
    conditionCount += 1;
  }
  if (args.excludeBrandTerms != null) {
    for (const term of args.excludeBrandTerms) {
      pushAnd(filters, ["keyword_data.keyword", "not_ilike", `%${term}%`]);
    }
    conditionCount += args.excludeBrandTerms.length;
  }
  assertFilterConditionBudget(conditionCount);
  return filters.length > 0 ? filters : undefined;
}

function sortCompetitors(
  items: Record<string, unknown>[],
  sortBy: FindSerpCompetitorsArgs["sortBy"],
) {
  const field =
    sortBy === "avg_position"
      ? "avg_position"
      : sortBy === "keyword_count"
        ? "keywords_count"
        : sortBy === "traffic_estimate"
          ? "etv"
          : "visibility";
  const direction = sortBy === "avg_position" ? 1 : -1;
  return sort(items, (a, b) => {
    const aValue = typeof a[field] === "number" ? a[field] : 0;
    const bValue = typeof b[field] === "number" ? b[field] : 0;
    return (aValue - bValue) * direction;
  });
}

// Project the shared canonical metric row onto this tool's snake_case API
// shape (kept stable for MCP clients); an absent trend stays null as before.
function toMcpKeywordMetricRow(row: KeywordMetricRow) {
  return {
    keyword: row.keyword,
    search_volume: row.searchVolume,
    keyword_difficulty: row.keywordDifficulty,
    main_intent: row.intent,
    cpc: row.cpc,
    competition: row.competition,
    competition_level: row.competitionLevel,
    monthly_searches: row.monthlySearches.length
      ? row.monthlySearches.map((entry) => ({
          year: entry.year,
          month: entry.month,
          search_volume: entry.searchVolume,
        }))
      : null,
  };
}

type McpKeywordMetricRow = ReturnType<typeof toMcpKeywordMetricRow>;

function sortKeywordMetricRows(
  rows: McpKeywordMetricRow[],
  sortBy: NonNullable<GetKeywordMetricsArgs["sortBy"]> = "search_volume",
) {
  return sort(rows, (a, b) => {
    const aValue = a[sortBy];
    const bValue = b[sortBy];
    const aNum = typeof aValue === "number" ? aValue : 0;
    const bNum = typeof bValue === "number" ? bValue : 0;
    return bNum - aNum;
  });
}

function hostMatchesDomain(host: string, domain: string): boolean {
  const normalizedHost = host.replace(/^www\./, "").toLowerCase();
  const normalizedDomain = domain.replace(/^www\./, "").toLowerCase();
  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith(`.${normalizedDomain}`)
  );
}

// Provider rows ship in full in structuredContent; these tables render every
// row into the text content block so text-only MCP clients see the data, not
// just a count. Loose rows are read positionally via readPath.

type RankedKeywordRow = {
  keyword: unknown;
  rank: unknown;
  volume: unknown;
  cpc: unknown;
  url: unknown;
};

function toRankedKeywordRow(item: unknown): RankedKeywordRow {
  return {
    keyword:
      readPath(item, "keyword_data", "keyword") ?? readPath(item, "keyword"),
    rank:
      readPath(item, "ranked_serp_element", "serp_item", "rank_absolute") ??
      readPath(item, "ranked_serp_element", "rank_absolute") ??
      readPath(item, "rank_absolute"),
    volume: readPath(item, "keyword_data", "keyword_info", "search_volume"),
    cpc: readPath(item, "keyword_data", "keyword_info", "cpc"),
    url:
      readPath(item, "ranked_serp_element", "serp_item", "url") ??
      readPath(item, "ranked_serp_element", "url"),
  };
}

const RANKED_KEYWORD_COLUMNS: McpTableColumn<RankedKeywordRow>[] = [
  { header: "keyword", value: (row) => row.keyword },
  { header: "rank", value: (row) => row.rank },
  { header: "volume", value: (row) => row.volume },
  { header: "CPC", value: (row) => row.cpc },
  { header: "url", value: (row) => row.url },
];

const SERP_COMPETITOR_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "domain", value: (row) => readPath(row, "domain") },
  { header: "keywords", value: (row) => readPath(row, "keywords_count") },
  { header: "avg pos", value: (row) => readPath(row, "avg_position") },
  { header: "median pos", value: (row) => readPath(row, "median_position") },
  { header: "visibility", value: (row) => readPath(row, "visibility") },
  { header: "etv", value: (row) => readPath(row, "etv") },
];

const KEYWORD_METRIC_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "keyword", value: (row) => readPath(row, "keyword") },
  { header: "volume", value: (row) => readPath(row, "search_volume") },
  { header: "KD", value: (row) => readPath(row, "keyword_difficulty") },
  { header: "CPC", value: (row) => readPath(row, "cpc") },
  { header: "competition", value: (row) => readPath(row, "competition") },
  { header: "intent", value: (row) => readPath(row, "main_intent") },
];

export const getRankedKeywordsTool = {
  name: "get_ranked_keywords",
  config: {
    title: "Get ranked keywords",
    description:
      "Returns market-specific keyword, URL, rank, search volume, CPC, intent, and traffic rows for a domain or page. Accepts country-level DataForSEO Labs location/language codes. Use this for strategy evidence; use get_domain_overview for aggregate domain footprint. Charges credits.",
    inputSchema: getRankedKeywordsInputSchema,
    outputSchema: {
      keywords: z.array(looseObjectOutputSchema),
      totalCount: z.number().nullable(),
      target: z.string().optional(),
      scope: researchScopeSchema.optional(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GetRankedKeywordsArgs, context) => {
    const client = createDataforseoClient(context.billing);
    // Legacy includeSubdomains only ever selected between whole-host scopes
    // for bare domains; for page URLs it meant exact-page results. Mapping it
    // to domain/subdomains for a URL target would silently drop the path.
    const parsedDefault = parseResearchTargetOrThrow(args.target);
    const legacyScope =
      args.includeSubdomains == null
        ? undefined
        : parsedDefault.path === ""
          ? args.includeSubdomains
            ? "subdomains"
            : "domain"
          : "exact_url";
    const requestedScope = args.scope ?? legacyScope;
    const target = requestedScope
      ? parseResearchTargetOrThrow(args.target, requestedScope)
      : parsedDefault;
    const scopeFilter = buildRankedKeywordsScopeFilter(target);
    const market = resolveMarketSelector(args, context.project);
    const keywords = await client.domain.rankedKeywords({
      target: target.hostname,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      limit: args.limit ?? 50,
      offset: args.offset,
      orderBy: sortOrderByRankedMode(args.sortBy),
      filters: buildRankedKeywordFilters(
        {
          minSearchVolume: args.minSearchVolume,
          maxRank: args.maxRank,
          excludeBrandTerms: args.excludeBrandTerms,
        },
        scopeFilter,
      ),
      itemTypes: args.resultTypes,
    });

    const rankedRows = keywords.items.map(toRankedKeywordRow);
    const targetLabel = `${target.display} (scope: ${target.scope})`;
    const text =
      rankedRows.length === 0
        ? `No ranked keyword rows for ${targetLabel}.`
        : `Found ${rankedRows.length} ranked keyword rows for ${targetLabel}${keywords.totalCount != null ? ` (of ${keywords.totalCount} total)` : ""}:\n${formatMcpTable(rankedRows, RANKED_KEYWORD_COLUMNS)}`;
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/domain`,
        { domain: target.display, scope: target.scope },
      ),
      structuredContent: {
        keywords: keywords.items,
        totalCount: keywords.totalCount,
        target: target.display,
        scope: target.scope,
      },
    });
  }),
};

export const findSerpCompetitorsTool = {
  name: "find_serp_competitors",
  config: {
    title: "Find SERP competitors",
    description:
      "Compares domains competing in Google results for a supplied keyword set in a country-level DataForSEO Labs market. Accepts location/language codes; not radius-based local SEO. Charges credits.",
    inputSchema: findSerpCompetitorsInputSchema,
    outputSchema: {
      competitors: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: FindSerpCompetitorsArgs, context) => {
      const client = createDataforseoClient(context.billing);
      const market = resolveMarketSelector(args, context.project);
      const competitors = await client.labs.serpCompetitors({
        keywords: args.keywords,
        locationCode: market.locationCode,
        languageCode: market.languageCode,
        itemTypes: args.resultTypes ?? ["organic", "local_pack"],
        includeSubdomains: args.includeSubdomains,
        limit: args.limit ?? 50,
        offset: args.offset,
      });
      const excludedDomains = args.excludeDomains ?? [];
      const filtered =
        excludedDomains.length === 0
          ? competitors
          : competitors.filter((item) => {
              const domain = typeof item.domain === "string" ? item.domain : "";
              return !excludedDomains.some((excludedDomain) =>
                hostMatchesDomain(domain, excludedDomain),
              );
            });
      const sorted = sortCompetitors(filtered, args.sortBy ?? "visibility");

      const header = `Found ${sorted.length} SERP competitors across ${args.keywords.length} keywords.`;
      return mcpResponse({
        text:
          sorted.length === 0
            ? header
            : `${header}\n${formatMcpTable(sorted, SERP_COMPETITOR_COLUMNS)}`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/domain`,
        ),
        structuredContent: { competitors: sorted },
      });
    },
  ),
};

export const getKeywordMetricsTool = {
  name: "get_keyword_metrics",
  config: {
    title: "Get keyword metrics",
    description:
      "Hydrate up to 700 known keywords with search volume, keyword difficulty (KD), search intent, CPC, competition, and monthly trends in a single call. Use it to score candidate or known keywords — including Search Console striking-distance queries — by real demand and ranking difficulty. For countries served from Google Ads data (e.g. Iceland), KD and intent are null. Charges credits.",
    inputSchema: getKeywordMetricsInputSchema,
    outputSchema: {
      keywords: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GetKeywordMetricsArgs, context) => {
    const { locationCode, languageCode } = resolveMarket(args, context.project);
    // Assert against the RESOLVED pair: an explicit language with an omitted
    // location must validate against the project's default location.
    assertLanguageForLocation(locationCode, languageCode);
    const client = createDataforseoClient(context.billing);
    const metrics = await fetchKeywordMetricsForList(client, {
      keywords: args.keywords,
      locationCode,
      languageCode,
      includeClickstreamData: args.includeClickstreamData ?? false,
      creditFeature: "keyword_research",
    });
    const rows = sortKeywordMetricRows(
      metrics.map(toMcpKeywordMetricRow),
      args.sortBy ?? "search_volume",
    ).map((row) =>
      args.includeMonthlyTrends === false
        ? Object.fromEntries(
            Object.entries(row).filter(([key]) => key !== "monthly_searches"),
          )
        : row,
    );

    const header = `Fetched metrics for ${rows.length} keywords. Columns: volume = monthly searches, KD = keyword difficulty (0-100), CPC in USD, competition = paid competition (0-1); "—" = unavailable.`;
    return mcpResponse({
      text:
        rows.length === 0
          ? header
          : `${header}\n${formatMcpTable(rows, KEYWORD_METRIC_COLUMNS)}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/keywords`,
      ),
      structuredContent: { keywords: rows },
    });
  }),
};
