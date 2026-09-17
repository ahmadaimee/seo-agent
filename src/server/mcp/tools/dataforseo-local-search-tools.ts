/* eslint-disable max-lines */
import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo";
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
import {
  businessIdentifierInputSchema,
  businessIdentifierKeyword,
  formatBusinessDataCoordinate,
  formatCoordinate,
  formatLocalSerpCoordinate,
  pickRowFields,
  pushAnd,
  resolveBusinessIdentifier,
} from "@/server/mcp/tools/local-seo-shared";
import { languageCodeSchema, projectIdSchema } from "@/server/mcp/schemas";

const nearSchema = z
  .object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe("Latitude of the search center."),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .describe("Longitude of the search center."),
    radiusKm: z
      .number()
      .min(1)
      .max(100000)
      .describe(
        "Search radius around the center, in whole kilometers (fractions are rounded).",
      ),
  })
  .describe("Coordinate and radius to search around.");

const localSerpNearSchema = z
  .object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe("Latitude the SERP is fetched from."),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .describe("Longitude the SERP is fetched from."),
    zoom: z
      .number()
      .int()
      .min(4)
      .max(18)
      .optional()
      .describe("Map zoom level (4-18). Higher zoom narrows the local area."),
  })
  .describe("Coordinate (and optional map zoom) the SERP is fetched from.");

const searchLocalBusinessesInputSchema = {
  projectId: projectIdSchema,
  query: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Business name or title text to match."),
  near: nearSchema,
  categories: z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(10)
    .optional()
    .describe("Business categories to filter by (e.g. 'pizza_restaurant')."),
  minRating: z
    .number()
    .min(1)
    .max(5)
    .optional()
    .describe("Only return businesses rated at least this (1-5)."),
  minReviews: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only return businesses with at least this many Google reviews."),
  isClaimed: z
    .boolean()
    .optional()
    .describe(
      "Filter by whether the listing is claimed by its owner. false surfaces unclaimed listings (outreach prospects).",
    ),
  sortBy: z
    .enum(["relevance", "rating", "reviews"])
    .optional()
    .describe("Sort order for returned rows. Defaults to relevance."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum businesses to return (1-50). Defaults to 20."),
  offset: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe("Rows to skip for pagination."),
} as const;

const localSearchTypeSchema = z.enum(["maps", "local_finder"]);

const getLocalSerpResultsInputSchema = {
  projectId: projectIdSchema,
  keyword: z
    .string()
    .min(1)
    .max(120)
    .describe("Search query to run on Google Maps or Local Finder."),
  near: localSerpNearSchema,
  searchType: localSearchTypeSchema
    .optional()
    .describe("Which local SERP to fetch. Defaults to maps."),
  device: z
    .enum(["desktop", "mobile"])
    .optional()
    .describe(
      "Device the SERP is rendered for. Defaults to mobile, matching get_local_rank_grid.",
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of results to fetch (1-100). Defaults to 20."),
  languageCode: languageCodeSchema.optional(),
} as const;

const getGoogleBusinessQuestionsInputSchema = {
  projectId: projectIdSchema,
  ...businessIdentifierInputSchema,
  near: nearSchema,
  depth: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum Q&A rows to fetch (1-100). Defaults to 20."),
  languageCode: languageCodeSchema.optional(),
} as const;

type SearchLocalBusinessesArgs = z.infer<
  z.ZodObject<typeof searchLocalBusinessesInputSchema>
>;
type GetLocalSerpResultsArgs = z.infer<
  z.ZodObject<typeof getLocalSerpResultsInputSchema>
>;
type GetGoogleBusinessQuestionsArgs = z.infer<
  z.ZodObject<typeof getGoogleBusinessQuestionsInputSchema>
>;

function formatBusinessLocationCoordinate(near: z.infer<typeof nearSchema>) {
  // Business Listings rejects fractional radii ("Invalid Field:
  // 'location_coordinate'"), unlike the meter-based business_data radius.
  const radiusKm = Math.max(1, Math.round(near.radiusKm));
  return `${formatCoordinate(near.latitude)},${formatCoordinate(near.longitude)},${radiusKm}`;
}

function buildLocalBusinessFilters(args: {
  minRating?: number;
  minReviews?: number;
}) {
  const filters: unknown[] = [];
  if (args.minRating != null) {
    pushAnd(filters, ["rating.value", ">=", args.minRating]);
  }
  if (args.minReviews != null) {
    pushAnd(filters, ["rating.votes_count", ">=", args.minReviews]);
  }
  return filters.length > 0 ? filters : undefined;
}

function localBusinessOrderBy(
  sortBy: SearchLocalBusinessesArgs["sortBy"],
): string[] | undefined {
  switch (sortBy) {
    case "rating":
      return ["rating.value,desc"];
    case "reviews":
      return ["rating.votes_count,desc"];
    default:
      return undefined;
  }
}

// Provider rows ship in full in structuredContent; these tables render every
// row into the text content block so text-only MCP clients see the data, not
// just a count. Loose rows are read positionally via readPath.

// Full Business Listings rows are ~9KB each (popular_times for every day,
// attribute trees, photo URLs) — 10 of them overflow MCP clients' tool-result
// budgets. Return only the fields a candidate list needs; get_business_profile
// serves the full shape for one business.
const LOCAL_BUSINESS_ROW_FIELDS = [
  "title",
  "description",
  "category",
  "additional_categories",
  "address",
  "phone",
  "url",
  "domain",
  "rating",
  "is_claimed",
  "cid",
  "place_id",
  "latitude",
  "longitude",
  "total_photos",
  "check_url",
] as const;

// Maps SERP rows likewise ship image CDN URLs, feature ids, and contributor
// links no consumer reads; keep identity, rank, rating, categories, and hours.
const LOCAL_SERP_ROW_FIELDS = [
  "rank_group",
  "rank_absolute",
  "title",
  "domain",
  "url",
  "contact_url",
  "address",
  "address_info",
  "phone",
  "category",
  "additional_categories",
  "rating",
  "rating_distribution",
  "price_level",
  "is_claimed",
  "cid",
  "place_id",
  "latitude",
  "longitude",
  "total_photos",
  "work_hours",
  "local_justifications",
] as const;

const LOCAL_BUSINESS_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "title", value: (row) => readPath(row, "title") },
  { header: "category", value: (row) => readPath(row, "category") },
  { header: "rating", value: (row) => readPath(row, "rating", "value") },
  { header: "reviews", value: (row) => readPath(row, "rating", "votes_count") },
  { header: "phone", value: (row) => readPath(row, "phone") },
  { header: "address", value: (row) => readPath(row, "address") },
];

const LOCAL_SERP_COLUMNS: McpTableColumn<unknown>[] = [
  {
    header: "rank",
    value: (row) =>
      readPath(row, "rank_absolute") ?? readPath(row, "rank_group"),
  },
  { header: "title", value: (row) => readPath(row, "title") },
  { header: "rating", value: (row) => readPath(row, "rating", "value") },
  { header: "reviews", value: (row) => readPath(row, "rating", "votes_count") },
  { header: "phone", value: (row) => readPath(row, "phone") },
  { header: "address", value: (row) => readPath(row, "address") },
];

// Q&A rows carry a ~300-char uule URL plus avatar/contributor links on every
// question AND every nested answer; keep the text, author, and timing.
const BUSINESS_QUESTION_ROW_FIELDS = [
  "rank_absolute",
  "question_id",
  "question_text",
  "original_question_text",
  "profile_name",
  "time_ago",
  "timestamp",
] as const;

const BUSINESS_ANSWER_ROW_FIELDS = [
  "answer_id",
  "answer_text",
  "original_answer_text",
  "profile_name",
  "time_ago",
  "timestamp",
] as const;

function trimBusinessQuestionRow(row: unknown): Record<string, unknown> {
  const trimmed = pickRowFields(row, BUSINESS_QUESTION_ROW_FIELDS);
  const answers = readPath(row, "items");
  trimmed.items = Array.isArray(answers)
    ? answers.map((answer) => pickRowFields(answer, BUSINESS_ANSWER_ROW_FIELDS))
    : null;
  return trimmed;
}

const BUSINESS_QUESTION_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "question", value: (row) => readPath(row, "question_text") },
  { header: "asked by", value: (row) => readPath(row, "profile_name") },
  { header: "when", value: (row) => readPath(row, "time_ago") },
  {
    header: "answers",
    value: (row) => {
      const answers = readPath(row, "items");
      return Array.isArray(answers) ? answers.length : 0;
    },
  },
];

export const searchLocalBusinessesTool = {
  name: "search_local_businesses",
  config: {
    title: "Search local businesses",
    description:
      "Searches local business listings near a coordinate, with optional rating, review-count, and claimed-status filters. Use this to find local business candidates, nearby competitors, or unclaimed listings; it does not run Maps rank checks or Q&A. Returns a compact row per business (identity, contact, rating, claim status); use get_business_profile for one business's full profile. Charges credits.",
    inputSchema: searchLocalBusinessesInputSchema,
    outputSchema: {
      businesses: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: SearchLocalBusinessesArgs, context) => {
      const client = createDataforseoClient(context.billing);
      const rows = await client.business.businessListings({
        categories: args.categories,
        title: args.query,
        locationCoordinate: formatBusinessLocationCoordinate(args.near),
        isClaimed: args.isClaimed,
        filters: buildLocalBusinessFilters(args),
        orderBy: localBusinessOrderBy(args.sortBy),
        limit: args.limit ?? 20,
        offset: args.offset,
      });
      const businesses = rows.map((row) =>
        pickRowFields(row, LOCAL_BUSINESS_ROW_FIELDS),
      );

      const header = `Found ${businesses.length} local business rows${args.query ? ` for ${args.query}` : ""}.`;
      return mcpResponse({
        text:
          businesses.length === 0
            ? header
            : `${header}\n${formatMcpTable(businesses, LOCAL_BUSINESS_COLUMNS)}`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { businesses },
      });
    },
  ),
};

export const getLocalSerpResultsTool = {
  name: "get_local_serp_results",
  config: {
    title: "Get local SERP results",
    description:
      "Fetches one Google Maps or Local Finder SERP near a coordinate. Returns trimmed provider rows (identity, rank, rating, categories, hours) with rank fields intact; callers decide how to match a target business. Charges credits.",
    inputSchema: getLocalSerpResultsInputSchema,
    outputSchema: {
      results: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: GetLocalSerpResultsArgs, context) => {
      const client = createDataforseoClient(context.billing);
      const rows = await client.serp.local({
        keyword: args.keyword,
        locationCoordinate: formatLocalSerpCoordinate(args.near),
        languageCode: args.languageCode ?? context.project.languageCode,
        searchType: args.searchType ?? "maps",
        device: args.device ?? "mobile",
        depth: args.depth ?? 20,
        searchPlaces: false,
      });
      const results = rows.map((row) =>
        pickRowFields(row, LOCAL_SERP_ROW_FIELDS),
      );

      const header = `Fetched ${results.length} local SERP rows for "${args.keyword}".`;
      return mcpResponse({
        text:
          results.length === 0
            ? header
            : `${header}\n${formatMcpTable(results, LOCAL_SERP_COLUMNS)}`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { results },
      });
    },
  ),
};

export const getGoogleBusinessQuestionsTool = {
  name: "get_google_business_questions",
  config: {
    title: "Get Google business questions",
    description:
      "Fetches Google Business Profile questions and answers for one business (by businessName, cid, or placeId) near a coordinate. Run this only when Q&A evidence is needed. Charges credits.",
    inputSchema: getGoogleBusinessQuestionsInputSchema,
    outputSchema: {
      questions: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: GetGoogleBusinessQuestionsArgs, context) => {
      const identifier = resolveBusinessIdentifier(args);
      const client = createDataforseoClient(context.billing);
      const rows = await client.business.questionsAnswers({
        // The questions endpoint shares the cid:/place_id: keyword prefixes.
        keyword: businessIdentifierKeyword(identifier),
        locationCoordinate: formatBusinessDataCoordinate(args.near),
        languageCode: args.languageCode ?? context.project.languageCode,
        depth: args.depth ?? 20,
      });
      const questions = rows.map(trimBusinessQuestionRow);

      const header = `Fetched ${questions.length} Google Business Q&A rows for ${businessIdentifierKeyword(identifier)}.`;
      return mcpResponse({
        text:
          questions.length === 0
            ? header
            : `${header}\n${formatMcpTable(questions, BUSINESS_QUESTION_COLUMNS)}`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structuredContent: { questions },
      });
    },
  ),
};
