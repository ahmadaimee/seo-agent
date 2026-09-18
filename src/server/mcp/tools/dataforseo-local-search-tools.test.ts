import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as localSearchTools from "./dataforseo-local-search-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();

const usProjectRow = {
  id: "project_1",
  locationCode: 2840,
  languageCode: "en",
};

describe("DataForSEO local search MCP tools", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue(usProjectRow);
  });

  it("searches local businesses, rounding fractional radii and trimming rows", async () => {
    const businessListings = vi.fn().mockResolvedValue([
      {
        title: "Acme Cafe",
        url: "https://acme-cafe.example",
        // Bulky fields that overflow MCP clients must not reach the response.
        popular_times: { monday: [] },
        attributes: { available_attributes: {} },
      },
    ]);
    const local = vi.fn();
    const questionsAnswers = vi.fn();

    mocks.createDataforseoClient.mockReturnValue({
      business: { businessListings, questionsAnswers },
      serp: { local },
    });

    const result = await localSearchTools.searchLocalBusinessesTool.handler(
      {
        projectId: "project_1",
        query: "Acme Cafe",
        near: {
          latitude: 33.123456789,
          longitude: -84.987654321,
          radiusKm: 1.5,
        },
        categories: ["cafe"],
      },
      toolContext,
    );

    // Business Listings rejects fractional radii: 1.5 km rounds to 2.
    expect(businessListings).toHaveBeenCalledWith(
      expect.objectContaining({
        locationCoordinate: "33.1234568,-84.9876543,2",
        categories: ["cafe"],
      }),
    );
    expect(local).not.toHaveBeenCalled();
    expect(questionsAnswers).not.toHaveBeenCalled();

    expect(result.structuredContent.businesses).toEqual([
      { title: "Acme Cafe", url: "https://acme-cafe.example" },
    ]);
    expect(textContent(result)).toContain("title | category");
    expect(textContent(result)).toContain("Acme Cafe");
  });

  it("maps local business rating/review/claim filters onto the provider call", async () => {
    const businessListings = vi.fn().mockResolvedValue([]);
    mocks.createDataforseoClient.mockReturnValue({
      business: { businessListings },
    });

    await localSearchTools.searchLocalBusinessesTool.handler(
      {
        projectId: "project_1",
        near: { latitude: 33, longitude: -84, radiusKm: 5 },
        minRating: 4,
        minReviews: 25,
        isClaimed: false,
        sortBy: "reviews",
        offset: 20,
      },
      toolContext,
    );

    expect(businessListings).toHaveBeenCalledWith(
      expect.objectContaining({
        isClaimed: false,
        filters: [
          ["rating.value", ">=", 4],
          "and",
          ["rating.votes_count", ">=", 25],
        ],
        orderBy: ["rating.votes_count,desc"],
        offset: 20,
      }),
    );
  });

  it("fetches one local SERP with search_places disabled and trims rows", async () => {
    const local = vi.fn().mockResolvedValue([
      {
        title: "Acme Cafe",
        rank_group: 1,
        rank_absolute: 2,
        // Dead-weight provider fields must not reach the response.
        main_image: "https://lh3.example/huge",
        feature_id: "0xabc:0xdef",
      },
    ]);

    mocks.createDataforseoClient.mockReturnValue({
      serp: { local },
    });
    const { getLocalSerpResultsTool } = localSearchTools;

    const result = await getLocalSerpResultsTool.handler(
      {
        projectId: "project_1",
        keyword: "coffee",
        near: {
          latitude: 33.123456789,
          longitude: -84.987654321,
          zoom: 14,
        },
      },
      toolContext,
    );

    expect(local).toHaveBeenCalledWith(
      expect.objectContaining({
        locationCoordinate: "33.1234568,-84.9876543,14z",
        searchPlaces: false,
        searchType: "maps",
        device: "mobile",
      }),
    );

    const content = z
      .object({ results: z.array(z.object({}).passthrough()) })
      .passthrough()
      .parse(result.structuredContent);
    expect(content.results).toEqual([
      { title: "Acme Cafe", rank_group: 1, rank_absolute: 2 },
    ]);
    expect(textContent(result)).toContain("rank | title | rating");
    expect(textContent(result)).toContain("Acme Cafe");
  });

  it("fetches Google Business Q&A as an explicit tool", async () => {
    const questionsAnswers = vi
      .fn()
      .mockResolvedValue([{ question_text: "Do you serve breakfast?" }]);

    mocks.createDataforseoClient.mockReturnValue({
      business: { questionsAnswers },
    });
    const { getGoogleBusinessQuestionsTool } = localSearchTools;

    const result = await getGoogleBusinessQuestionsTool.handler(
      {
        projectId: "project_1",
        cid: "123",
        near: {
          latitude: 33.123456789,
          longitude: -84.987654321,
          radiusKm: 5,
        },
      },
      toolContext,
    );

    expect(questionsAnswers).toHaveBeenCalledWith(
      expect.objectContaining({
        // The identifier trio rides the shared cid:/place_id: prefixes.
        keyword: "cid:123",
        locationCoordinate: "33.1234568,-84.9876543,5000",
      }),
    );
    const content = z
      .object({ questions: z.array(z.object({ question_text: z.string() })) })
      .passthrough()
      .parse(result.structuredContent);
    expect(content.questions).toEqual([
      { question_text: "Do you serve breakfast?" },
    ]);
    expect(textContent(result)).toContain("question | asked by");
    expect(textContent(result)).toContain("Do you serve breakfast?");
  });
});
