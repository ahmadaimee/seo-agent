import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { languageCodeSchema, projectIdSchema } from "@/server/mcp/schemas";
import { readPath } from "@/server/mcp/table";
import { formatLocalSerpCoordinate } from "@/server/mcp/tools/local-seo-shared";

function readString(source: unknown, key: string): string | null {
  const value = readPath(source, key);
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// get_local_rank_grid
// ---------------------------------------------------------------------------

// Degrees per kilometre. Longitude degrees shrink with latitude; the cosine is
// floored so a near-polar center can't blow the spacing up.
const KM_PER_DEGREE_LATITUDE = 110.574;
const KM_PER_DEGREE_LONGITUDE = 111.32;
const MIN_LONGITUDE_COSINE = 0.01;
const RANK_GRID_DEPTH = 20;
const RANK_GRID_CONCURRENCY = 3;
// Without an explicit zoom DataForSEO infers one per coordinate, which yields
// "No Search Results" for some points and makes ranks incomparable across the
// grid. A fixed zoom fails the other way: a mobile viewport at zoom 14 spans
// only ~±1.5 km east-west at mid latitudes, so a business one 2-3 km grid step
// to the side falls outside the viewport and reads as "not ranked" (verified
// live: a rank-3 business vanished at zoom 14 and reappeared at zoom 12).
// Derive the zoom from the spacing instead: a world tile is 40075·cos(lat)/2^z
// km wide and a portrait viewport ~1.5 tiles, so the largest zoom whose
// viewport still spans ~1.25× the spacing is log2(24045·cos(lat)/spacing).
const RANK_GRID_ZOOM_NUMERATOR_KM = 24045;
const MIN_RANK_GRID_ZOOM = 4;
const MAX_RANK_GRID_ZOOM = 18;

function rankGridZoom(spacingKm: number, latitude: number): number {
  const cosine = Math.max(
    Math.abs(Math.cos((latitude * Math.PI) / 180)),
    MIN_LONGITUDE_COSINE,
  );
  const zoom = Math.floor(
    Math.log2((RANK_GRID_ZOOM_NUMERATOR_KM * cosine) / spacingKm),
  );
  return Math.min(MAX_RANK_GRID_ZOOM, Math.max(MIN_RANK_GRID_ZOOM, zoom));
}

const getLocalRankGridInputSchema = {
  projectId: projectIdSchema,
  keyword: z
    .string()
    .min(1)
    .max(120)
    .describe("Search query to run on Google Maps at every grid point."),
  target: z
    .object({
      cid: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Match rows whose cid equals this value (most reliable)."),
      placeId: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe("Match rows whose place_id equals this value."),
      name: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Match rows whose title contains this text (case-insensitive). Used only when cid/placeId do not match.",
        ),
    })
    .describe(
      "The business to locate in each result set. Supply at least one of cid, placeId, or name.",
    ),
  center: z
    .object({
      latitude: z.number().min(-90).max(90).describe("Latitude of the center."),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .describe("Longitude of the center."),
    })
    .describe("Coordinate the grid is centered on (usually the storefront)."),
  gridSize: z
    .union([z.literal(3), z.literal(5)])
    .optional()
    .describe("Grid width: 3 (9 searches) or 5 (25 searches). Defaults to 3."),
  spacingKm: z
    .number()
    .min(0.25)
    .max(10)
    .optional()
    .describe(
      "Distance between neighbouring grid points, in km. Defaults to 2.",
    ),
  device: z
    .enum(["desktop", "mobile"])
    .optional()
    .describe("Device the SERP is rendered for. Defaults to mobile."),
  zoom: z
    .number()
    .int()
    .min(4)
    .max(18)
    .optional()
    .describe(
      "Map zoom every point is searched at. Defaults to a zoom derived from spacingKm and latitude so each point's viewport spans the grid spacing; override only when you need a specific viewport.",
    ),
  languageCode: languageCodeSchema.optional(),
} as const;

type GetLocalRankGridArgs = z.infer<
  z.ZodObject<typeof getLocalRankGridInputSchema>
>;

type GridPoint = {
  row: number;
  col: number;
  latitude: number;
  longitude: number;
};

type GridPointResult = GridPoint & {
  rank: number | null;
  // How many businesses the SERP returned there, and who ranked first: a null
  // rank with a full result set means outranked; with a near-empty one it
  // means a sparse SERP. Both absent when the point's search failed.
  resultsCount?: number;
  topResult?: { title: string | null; cid: string | null } | null;
  error?: boolean;
};

function buildRankGridPoints(
  center: { latitude: number; longitude: number },
  gridSize: number,
  spacingKm: number,
): GridPoint[] {
  const middle = (gridSize - 1) / 2;
  const latitudeStep = spacingKm / KM_PER_DEGREE_LATITUDE;
  const longitudeStep =
    spacingKm /
    (KM_PER_DEGREE_LONGITUDE *
      Math.max(
        Math.abs(Math.cos((center.latitude * Math.PI) / 180)),
        MIN_LONGITUDE_COSINE,
      ));

  const points: GridPoint[] = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      points.push({
        row,
        col,
        // Row 0 is the northernmost line so the rendered grid reads like a map.
        latitude: Number(
          (center.latitude + (middle - row) * latitudeStep).toFixed(7),
        ),
        longitude: Number(
          (center.longitude + (col - middle) * longitudeStep).toFixed(7),
        ),
      });
    }
  }
  return points;
}

function matchGridItem(
  items: unknown[],
  target: { cid?: string; placeId?: string; name?: string },
) {
  const name = target.name?.toLowerCase();
  return items.find((item) => {
    if (target.cid != null && readPath(item, "cid") === target.cid) return true;
    if (target.placeId != null && readPath(item, "place_id") === target.placeId)
      return true;
    if (name == null) return false;
    const title = readPath(item, "title");
    return typeof title === "string" && title.toLowerCase().includes(name);
  });
}

// A per-point failure usually means only that point's SERP failed, but these
// codes mean every remaining call would fail (and possibly bill) the same way —
// surface them instead of rendering a misleading grid.
const GRID_ABORT_ERROR_CODES = new Set<string>([
  "INSUFFICIENT_CREDITS",
  "DATAFORSEO_AUTH_FAILED",
]);

function renderGrid(results: GridPointResult[], gridSize: number): string {
  const lines: string[] = [];
  for (let row = 0; row < gridSize; row++) {
    // buildRankGridPoints emits row-major order and results keep it.
    const cells = results
      .slice(row * gridSize, (row + 1) * gridSize)
      .map((point) =>
        (point.error ? "x" : (point.rank?.toString() ?? "–")).padStart(2, " "),
      );
    lines.push(cells.join(" "));
  }
  return lines.join("\n");
}

export const getLocalRankGridTool = {
  name: "get_local_rank_grid",
  config: {
    title: "Get local rank grid",
    description:
      "Runs one Google Maps search per point of a square grid around a coordinate and reports where the target business ranks at each point — plus each point's result count and #1 business — revealing how far its Maps visibility reaches. Cost scales with the grid: gridSize squared SERP calls (3x3 = 9, the sensible default; 5x5 = 25). Charges credits per grid point.",
    inputSchema: getLocalRankGridInputSchema,
    outputSchema: {
      grid: z.array(
        z.object({
          row: z.number(),
          col: z.number(),
          latitude: z.number(),
          longitude: z.number(),
          rank: z.number().nullable(),
          resultsCount: z.number().optional(),
          topResult: z
            .object({
              title: z.string().nullable(),
              cid: z.string().nullable(),
            })
            .nullable()
            .optional(),
          error: z.boolean().optional(),
        }),
      ),
      summary: z.object({
        pointsSearched: z.number(),
        pointsFound: z.number(),
        averageRank: z.number().nullable(),
        top3Count: z.number(),
        top10Count: z.number(),
      }),
      matchedBusiness: z
        .object({
          title: z.string().nullable(),
          cid: z.string().nullable(),
          placeId: z.string().nullable(),
        })
        .nullable(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GetLocalRankGridArgs, context) => {
    if (
      args.target.cid == null &&
      args.target.placeId == null &&
      args.target.name == null
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "target needs at least one of cid, placeId, or name.",
      );
    }

    const gridSize = args.gridSize ?? 3;
    const spacingKm = args.spacingKm ?? 2;
    const zoom = args.zoom ?? rankGridZoom(spacingKm, args.center.latitude);
    const points = buildRankGridPoints(args.center, gridSize, spacingKm);
    const client = createDataforseoClient(context.billing);
    const languageCode = args.languageCode ?? context.project.languageCode;

    let matchedBusiness: {
      title: string | null;
      cid: string | null;
      placeId: string | null;
    } | null = null;
    let lastError: unknown = null;

    const searchPoint = async (point: GridPoint): Promise<GridPointResult> => {
      try {
        const items = await client.serp.local({
          keyword: args.keyword,
          locationCoordinate: formatLocalSerpCoordinate({ ...point, zoom }),
          languageCode,
          searchType: "maps",
          device: args.device ?? "mobile",
          depth: RANK_GRID_DEPTH,
          searchPlaces: false,
        });
        const match = matchGridItem(items, args.target);
        if (match && !matchedBusiness) {
          matchedBusiness = {
            title: readString(match, "title"),
            cid: readString(match, "cid"),
            placeId: readString(match, "place_id"),
          };
        }
        const rank =
          readPath(match, "rank_absolute") ?? readPath(match, "rank_group");
        const first = items[0];
        return {
          ...point,
          rank: typeof rank === "number" ? rank : null,
          resultsCount: items.length,
          topResult:
            first == null
              ? null
              : {
                  title: readString(first, "title"),
                  cid: readString(first, "cid"),
                },
        };
      } catch (error) {
        if (error instanceof AppError && GRID_ABORT_ERROR_CODES.has(error.code))
          throw error;
        lastError = error;
        return { ...point, rank: null, error: true };
      }
    };

    // A few points at a time; an abort-worthy failure rejects its batch and
    // stops later batches from dispatching (and billing).
    const grid: GridPointResult[] = [];
    for (let i = 0; i < points.length; i += RANK_GRID_CONCURRENCY) {
      const batch = points.slice(i, i + RANK_GRID_CONCURRENCY);
      grid.push(...(await Promise.all(batch.map(searchPoint))));
    }

    // Every point failing means a systemic failure (auth, balance, bad market),
    // not a business that simply doesn't rank — surface it instead of an empty grid.
    if (grid.every((point) => point.error)) throw lastError;

    const found = grid.filter((point) => point.rank != null);
    const ranks = found.map((point) => point.rank ?? 0);
    const summary = {
      pointsSearched: grid.length,
      pointsFound: found.length,
      averageRank: ranks.length
        ? Number(
            (ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length).toFixed(
              2,
            ),
          )
        : null,
      top3Count: ranks.filter((rank) => rank <= 3).length,
      top10Count: ranks.filter((rank) => rank <= 10).length,
    };

    const text = [
      `Local rank grid for "${args.keyword}" (${gridSize}x${gridSize}, ${spacingKm} km spacing, zoom ${zoom}, top ${RANK_GRID_DEPTH} checked).`,
      `Rank per point, north at the top ("–" = not among the results returned there; check that point's resultsCount and topResult before reading it as outranked, "x" = search failed but may still be charged):`,
      renderGrid(grid, gridSize),
      `- ranked at ${summary.pointsFound} of ${summary.pointsSearched} points`,
      `- average rank where found: ${summary.averageRank ?? "—"}`,
      `- top 3 at ${summary.top3Count} points, top 10 at ${summary.top10Count} points`,
    ].join("\n");

    return mcpResponse({
      text,
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: { grid, summary, matchedBusiness },
    });
  }),
};
