import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import {
  getBusinessProfileTool,
  getBusinessReviewsTool,
  listBusinessCategoriesTool,
} from "./local-seo-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  fetchBusinessDataTaskResult: vi.fn(),
  fetchBusinessListingsCategories: vi.fn(),
  getProjectForOrganization: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
  fetchBusinessDataTaskResult: mocks.fetchBusinessDataTaskResult,
  fetchBusinessListingsCategories: mocks.fetchBusinessListingsCategories,
}));

vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: (prefix: string) => Promise.resolve(`${prefix}:key`),
  getCached: mocks.getCached,
  setCached: mocks.setCached,
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();

beforeEach(() => {
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.getCached.mockResolvedValue(null);
});

describe("get_business_profile", () => {
  it("rejects anything other than exactly one business identifier", async () => {
    await expect(
      getBusinessProfileTool.handler(
        { projectId: "project_1", businessName: "Acme Cafe", cid: "123" },
        toolContext,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(
      getBusinessProfileTool.handler({ projectId: "project_1" }, toolContext),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("passes a cid as a prefixed keyword with a metre-radius coordinate", async () => {
    const myBusinessInfo = vi.fn().mockResolvedValue({
      title: "Acme Cafe",
      category: "Coffee shop",
      rating: { value: 4.6, votes_count: 210 },
      is_claimed: true,
    });
    mocks.createDataforseoClient.mockReturnValue({
      business: { myBusinessInfo },
    });

    const result = await getBusinessProfileTool.handler(
      {
        projectId: "project_1",
        cid: "123",
        near: { latitude: 33.123456789, longitude: -84.987654321, radiusKm: 5 },
      },
      toolContext,
    );

    expect(myBusinessInfo).toHaveBeenCalledWith({
      keyword: "cid:123",
      locationCoordinate: "33.1234568,-84.9876543,5000",
      locationCode: undefined,
      languageCode: "en",
    });
    const out = textContent(result);
    expect(out).toContain("- title: Acme Cafe");
    expect(out).toContain("- rating: 4.60 from 210 reviews");
    expect(out).toContain("- claimed: yes");
  });

  it("falls back to the project market when no coordinate is given", async () => {
    const myBusinessInfo = vi.fn().mockResolvedValue(null);
    mocks.createDataforseoClient.mockReturnValue({
      business: { myBusinessInfo },
    });

    const result = await getBusinessProfileTool.handler(
      { projectId: "project_1", businessName: "Acme Cafe" },
      toolContext,
    );

    expect(myBusinessInfo).toHaveBeenCalledWith({
      keyword: "Acme Cafe",
      locationCoordinate: undefined,
      locationCode: 2840,
      languageCode: "en",
    });
    expect(result.structuredContent.profile).toBeNull();
  });
});

describe("get_business_reviews", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a resumable taskId when the task is still queued", async () => {
    vi.useFakeTimers();
    const reviewsTaskPost = vi.fn().mockResolvedValue("task-1");
    mocks.createDataforseoClient.mockReturnValue({
      business: { reviewsTaskPost },
    });
    mocks.fetchBusinessDataTaskResult.mockResolvedValue({
      status: "pending",
      result: null,
    });

    const pending = getBusinessReviewsTool.handler(
      { projectId: "project_1", cid: "123" },
      toolContext,
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(reviewsTaskPost).toHaveBeenCalledWith(
      expect.objectContaining({
        cid: "123",
        depth: 20,
        sortBy: "newest",
        includeOtherSources: false,
      }),
    );
    expect(result.structuredContent).toMatchObject({
      status: "processing",
      taskId: "google:task-1",
    });
    expect(textContent(result)).toContain('taskId "google:task-1"');
  });

  it("keeps the taskId recoverable when collection fails after a paid post", async () => {
    const reviewsTaskPost = vi.fn().mockResolvedValue("task-1");
    mocks.createDataforseoClient.mockReturnValue({
      business: { reviewsTaskPost },
    });
    mocks.fetchBusinessDataTaskResult.mockRejectedValue(
      new AppError("UPSTREAM_UNAVAILABLE", "DataForSEO HTTP 502"),
    );

    const failing = getBusinessReviewsTool.handler(
      { projectId: "project_1", cid: "123" },
      toolContext,
    );
    await expect(failing).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    await expect(failing).rejects.toThrow('taskId "google:task-1"');
  });

  it("resumes from a taskId without posting a new task", async () => {
    const reviewsTaskPost = vi.fn();
    mocks.createDataforseoClient.mockReturnValue({
      business: { reviewsTaskPost },
    });
    mocks.fetchBusinessDataTaskResult.mockResolvedValue({
      status: "completed",
      result: {
        reviews_count: 2,
        items: [
          {
            rank_absolute: 1,
            time_ago: "a month ago",
            rating: { value: 5 },
            profile_name: "Cam P.",
            review_text: "Rare bottles and great staff.",
            owner_answer: "Thanks!",
          },
        ],
      },
    });

    const result = await getBusinessReviewsTool.handler(
      { projectId: "project_1", taskId: "extended:task-9" },
      toolContext,
    );

    expect(reviewsTaskPost).not.toHaveBeenCalled();
    // The prefix picks the endpoint, so a resume never needs the original args.
    expect(mocks.fetchBusinessDataTaskResult).toHaveBeenCalledWith({
      endpoint: "extended_reviews",
      taskId: "task-9",
    });
    expect(result.structuredContent).toMatchObject({
      status: "completed",
      taskId: "extended:task-9",
    });
    const out = textContent(result);
    expect(out).toContain("# | when | rating | author | source | review");
    expect(out).toContain("Rare bottles and great staff.");
    expect(out).toContain("| yes");
  });

  it("rejects a taskId that did not come from this tool", async () => {
    await expect(
      getBusinessReviewsTool.handler(
        { projectId: "project_1", taskId: "task-9" },
        toolContext,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("list_business_categories", () => {
  const categories = [
    { category: "pizza_restaurant", businessCount: 120 },
    { category: "plumber", businessCount: 90 },
  ];

  it("caches the full list and filters it in memory", async () => {
    mocks.fetchBusinessListingsCategories.mockResolvedValue({
      data: categories,
      billing: { path: [], costUsd: 0 },
    });

    const result = await listBusinessCategoriesTool.handler(
      { projectId: "project_1", query: "PIZZA" },
      toolContext,
    );

    // Free endpoint: must never touch the metered client (a zero-credit org
    // would otherwise be refused by the credit gate).
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
    expect(mocks.setCached).toHaveBeenCalledTimes(1);
    expect(result.structuredContent.categories).toEqual([
      { category: "pizza_restaurant", businessCount: 120 },
    ]);
    expect(textContent(result)).toContain("pizza_restaurant | 120");
  });

  it("serves a cache hit without calling the provider", async () => {
    mocks.getCached.mockResolvedValue(categories);

    const result = await listBusinessCategoriesTool.handler(
      { projectId: "project_1" },
      toolContext,
    );

    expect(mocks.fetchBusinessListingsCategories).not.toHaveBeenCalled();
    expect(mocks.setCached).not.toHaveBeenCalled();
    expect(result.structuredContent.categories).toEqual(categories);
  });
});
