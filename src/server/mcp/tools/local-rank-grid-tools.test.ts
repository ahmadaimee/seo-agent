import { sort } from "remeda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { getLocalRankGridTool } from "./local-rank-grid-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();

const sorted = (values: string[]) => sort(values, (a, b) => a.localeCompare(b));

beforeEach(() => {
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    locationCode: 2840,
    languageCode: "en",
  });
});

describe("get_local_rank_grid", () => {
  const gridItems = (items: unknown[]) =>
    vi
      .fn<(input: { locationCoordinate: string }) => Promise<unknown[]>>()
      .mockResolvedValue(items);
  it("searches a 3x3 grid of coordinates around the center", async () => {
    const local = gridItems([]);
    mocks.createDataforseoClient.mockReturnValue({ serp: { local } });

    await getLocalRankGridTool.handler(
      {
        projectId: "project_1",
        keyword: "coffee",
        target: { cid: "123" },
        center: { latitude: 40, longitude: -74 },
        spacingKm: 2,
      },
      toolContext,
    );

    // 2 km spacing at latitude 40: 0.0180874 deg of latitude, 0.0234532 deg of
    // longitude. Row 0 is the northern edge. Every point carries a zoom derived
    // from the spacing (13z here) so each point's viewport spans its neighbours
    // instead of hiding businesses one grid step east or west.
    expect(
      sorted(local.mock.calls.map(([input]) => input.locationCoordinate)),
    ).toEqual(
      sorted([
        "40.0180874,-74.0234532,13z",
        "40.0180874,-74,13z",
        "40.0180874,-73.9765468,13z",
        "40,-74.0234532,13z",
        "40,-74,13z",
        "40,-73.9765468,13z",
        "39.9819126,-74.0234532,13z",
        "39.9819126,-74,13z",
        "39.9819126,-73.9765468,13z",
      ]),
    );
    expect(local).toHaveBeenCalledWith(
      expect.objectContaining({
        searchType: "maps",
        device: "mobile",
        depth: 20,
      }),
    );
  });

  it("ranks by exact cid match and summarizes coverage", async () => {
    const local = gridItems([
      { rank_absolute: 1, title: "Other Cafe", cid: "999" },
      { rank_absolute: 2, title: "Acme Cafe", cid: "123", place_id: "p1" },
    ]);
    mocks.createDataforseoClient.mockReturnValue({ serp: { local } });

    const result = await getLocalRankGridTool.handler(
      {
        projectId: "project_1",
        keyword: "coffee",
        target: { cid: "123" },
        center: { latitude: 40, longitude: -74 },
      },
      toolContext,
    );

    expect(result.structuredContent).toMatchObject({
      summary: {
        pointsSearched: 9,
        pointsFound: 9,
        averageRank: 2,
        top3Count: 9,
      },
      matchedBusiness: { title: "Acme Cafe", cid: "123", placeId: "p1" },
    });
    expect(textContent(result)).toContain(" 2  2  2");
  });

  it("records each point's result count and top business so nulls are interpretable", async () => {
    const local = gridItems([
      { rank_absolute: 1, title: "Other Cafe", cid: "999" },
    ]);
    mocks.createDataforseoClient.mockReturnValue({ serp: { local } });

    const result = await getLocalRankGridTool.handler(
      {
        projectId: "project_1",
        keyword: "coffee",
        target: { cid: "123" },
        center: { latitude: 40, longitude: -74 },
      },
      toolContext,
    );

    // The target is absent, but the point still says how contested it was.
    expect(result.structuredContent.grid[0]).toMatchObject({
      rank: null,
      resultsCount: 1,
      topResult: { title: "Other Cafe", cid: "999" },
    });
  });

  it("aborts the grid on a credits failure instead of billing every point", async () => {
    const local = vi
      .fn()
      .mockRejectedValue(new AppError("INSUFFICIENT_CREDITS", "No credits"));
    mocks.createDataforseoClient.mockReturnValue({ serp: { local } });

    await expect(
      getLocalRankGridTool.handler(
        {
          projectId: "project_1",
          keyword: "coffee",
          target: { cid: "123" },
          center: { latitude: 40, longitude: -74 },
        },
        toolContext,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    // Only the first batch may have dispatched; later batches must not bill.
    expect(local.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("falls back to a case-insensitive title match", async () => {
    const local = gridItems([
      { rank_absolute: 4, title: "ACME Cafe Downtown" },
    ]);
    mocks.createDataforseoClient.mockReturnValue({ serp: { local } });

    const result = await getLocalRankGridTool.handler(
      {
        projectId: "project_1",
        keyword: "coffee",
        target: { name: "acme cafe" },
        center: { latitude: 40, longitude: -74 },
      },
      toolContext,
    );

    expect(result.structuredContent.summary).toMatchObject({
      pointsFound: 9,
      averageRank: 4,
    });
  });

  it("keeps the grid when a single point fails", async () => {
    let call = 0;
    const local = vi.fn().mockImplementation(() => {
      call += 1;
      return call === 1
        ? Promise.reject(new Error("upstream blew up"))
        : Promise.resolve([{ rank_absolute: 3, cid: "123" }]);
    });
    mocks.createDataforseoClient.mockReturnValue({ serp: { local } });

    const result = await getLocalRankGridTool.handler(
      {
        projectId: "project_1",
        keyword: "coffee",
        target: { cid: "123" },
        center: { latitude: 40, longitude: -74 },
      },
      toolContext,
    );

    expect(result.structuredContent.summary).toMatchObject({
      pointsSearched: 9,
      pointsFound: 8,
    });
    expect(textContent(result)).toContain("x");
  });

  it("surfaces the upstream error when every point fails", async () => {
    const local = vi.fn().mockRejectedValue(new Error("upstream blew up"));
    mocks.createDataforseoClient.mockReturnValue({ serp: { local } });

    await expect(
      getLocalRankGridTool.handler(
        {
          projectId: "project_1",
          keyword: "coffee",
          target: { cid: "123" },
          center: { latitude: 40, longitude: -74 },
        },
        toolContext,
      ),
    ).rejects.toThrow("upstream blew up");
  });
});
