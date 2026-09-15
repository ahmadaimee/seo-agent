import type { CreateMcpHandlerOptions } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkersOAuthMcpProps,
  MCP_AUTH_CONTEXT_PROP,
} from "@/server/mcp/context";
import {
  handleAuthenticatedSeoAgentMcpRequest,
  handleSelfHostedSeoAgentMcpRequest,
} from "@/server/mcp/transport";

const selfHostedAuthMocks = vi.hoisted(() => ({
  resolveCloudflareAccessContext: vi.fn(),
  resolveLocalNoAuthContext: vi.fn(),
  createSeoAgentMcpServer: vi.fn(),
  createMcpHandler: vi.fn(),
}));

const authRepositoryMocks = vi.hoisted(() => ({
  getMembership: vi.fn(),
}));

vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: authRepositoryMocks,
}));

vi.mock("@/middleware/ensure-user/cloudflareAccess", () => ({
  resolveCloudflareAccessContext:
    selfHostedAuthMocks.resolveCloudflareAccessContext,
}));

vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveLocalNoAuthContext: selfHostedAuthMocks.resolveLocalNoAuthContext,
}));

vi.mock("@/lib/auth", () => ({
  getHostedBaseUrl: () => "https://seo-agent.test",
}));

vi.mock("@/server/mcp/server", () => ({
  createSeoAgentMcpServer: (props?: unknown) => {
    selfHostedAuthMocks.createSeoAgentMcpServer(props);
    return new McpServer({
      name: "S.E.O Agent MCP",
      title: "S.E.O Agent",
      version: "0.0.11",
      description: "SEO research tools for AI agents",
      websiteUrl: "https://github.com/ahmadaimee/seo-agent",
      icons: [
        {
          src: "https://github.com/ahmadaimee/seo-agent/android-chrome-512x512.png",
          mimeType: "image/png",
          sizes: ["512x512"],
        },
      ],
    });
  },
}));

vi.mock("agents/mcp/server", () => ({
  createMcpHandler: (
    _createServer: () => McpServer,
    options: CreateMcpHandlerOptions,
  ) => {
    selfHostedAuthMocks.createMcpHandler(options);
    return async () => Response.json({ handledBy: "modern" }, { status: 202 });
  },
}));

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

function createMcpRequest(headers?: Record<string, string>) {
  return new Request("https://seo-agent.test/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }),
  });
}

// The modern (2026-07-28) era is selected by the per-request `_meta` envelope
// claim; without it every POST classifies as legacy traffic.
function createModernMcpRequest(headers?: Record<string, string>) {
  return new Request("https://seo-agent.test/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

function hostedProps(scopes: string[] = ["mcp"]) {
  return createWorkersOAuthMcpProps({
    userId: "user-1",
    userEmail: "user@example.com",
    organizationId: "org-1",
    baseUrl: "https://seo-agent.test",
    clientId: "client-1",
    scopes,
  });
}

describe("handleSelfHostedSeoAgentMcpRequest", () => {
  beforeEach(() => {
    selfHostedAuthMocks.resolveLocalNoAuthContext.mockResolvedValue({
      userId: "local-admin",
      userEmail: "admin@localhost",
      organizationId: "delegated-local-admin",
    });
    selfHostedAuthMocks.resolveCloudflareAccessContext.mockResolvedValue({
      userId: "cloudflare-user",
      userEmail: "person@example.com",
      organizationId: "delegated-cloudflare-user",
    });
  });

  it("accepts local no-auth MCP requests with the local admin context", async () => {
    const response = await handleSelfHostedSeoAgentMcpRequest(
      createMcpRequest(),
      "local_noauth",
      {},
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("connection")).not.toBe("keep-alive");
    expect(selfHostedAuthMocks.resolveLocalNoAuthContext).toHaveBeenCalled();
    expect(selfHostedAuthMocks.createSeoAgentMcpServer).toHaveBeenCalledWith({
      [MCP_AUTH_CONTEXT_PROP]: {
        userId: "local-admin",
        userEmail: "admin@localhost",
        organizationId: "delegated-local-admin",
        baseUrl: "https://seo-agent.test",
      },
    });
    // Self-hosted must not pin Origins to the request's own Host — the
    // handler's localhost-class default is the rebinding-safe choice.
    expect(selfHostedAuthMocks.createMcpHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedOriginHostnames: undefined,
        legacy: "reject",
      }),
    );
  });

  it("accepts Cloudflare Access MCP requests through the existing Access resolver", async () => {
    const response = await handleSelfHostedSeoAgentMcpRequest(
      createMcpRequest(),
      "cloudflare_access",
      {},
      ctx,
    );

    expect(response.status).toBe(200);
    expect(
      selfHostedAuthMocks.resolveCloudflareAccessContext,
    ).toHaveBeenCalledWith(expect.any(Headers));
    expect(selfHostedAuthMocks.createSeoAgentMcpServer).toHaveBeenCalledWith({
      [MCP_AUTH_CONTEXT_PROP]: {
        userId: "cloudflare-user",
        userEmail: "person@example.com",
        organizationId: "delegated-cloudflare-user",
        baseUrl: "https://seo-agent.test",
      },
    });
  });

  it("answers OPTIONS preflight without resolving an auth context", async () => {
    const response = await handleSelfHostedSeoAgentMcpRequest(
      new Request("https://seo-agent.test/mcp", { method: "OPTIONS" }),
      "cloudflare_access",
      {},
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(
      selfHostedAuthMocks.resolveCloudflareAccessContext,
    ).not.toHaveBeenCalled();
    expect(selfHostedAuthMocks.createSeoAgentMcpServer).not.toHaveBeenCalled();
  });
});

describe("handleAuthenticatedSeoAgentMcpRequest", () => {
  beforeEach(() => {
    authRepositoryMocks.getMembership.mockResolvedValue({ role: "owner" });
  });

  it("accepts the provider's encrypted identity and MCP scope fallback", async () => {
    const props = hostedProps();

    const response = await handleAuthenticatedSeoAgentMcpRequest(
      createMcpRequest(),
      props,
      {},
      { ...ctx, props },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("connection")).not.toBe("keep-alive");
    expect(selfHostedAuthMocks.createMcpHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedOriginHostnames: [
          "seo-agent.test",
          "pghallcbnfabbgfijhbcldaapmgidnaa",
        ],
        legacy: "reject",
      }),
    );
    // The transport stamps the per-request role into the props it hands the
    // server; roles are never baked into tokens.
    expect(selfHostedAuthMocks.createSeoAgentMcpServer).toHaveBeenCalledWith({
      [MCP_AUTH_CONTEXT_PROP]: {
        ...props[MCP_AUTH_CONTEXT_PROP],
        role: "owner",
      },
    });
  });

  it("routes modern-era requests to the SDK handler", async () => {
    const props = hostedProps();

    const response = await handleAuthenticatedSeoAgentMcpRequest(
      createModernMcpRequest(),
      props,
      {},
      { ...ctx, props },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ handledBy: "modern" });
    // The modern handler owns server construction; the legacy leg must not
    // have built one.
    expect(selfHostedAuthMocks.createSeoAgentMcpServer).not.toHaveBeenCalled();
  });

  it("accepts a modern request from the exact SurfMind extension origin", async () => {
    const props = hostedProps();

    const response = await handleAuthenticatedSeoAgentMcpRequest(
      createModernMcpRequest({
        Origin: "chrome-extension://pghallcbnfabbgfijhbcldaapmgidnaa",
      }),
      props,
      {},
      { ...ctx, props },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ handledBy: "modern" });
  });

  it("rejects a legacy request from a disallowed Origin", async () => {
    const props = hostedProps();

    const response = await handleAuthenticatedSeoAgentMcpRequest(
      createMcpRequest({ Origin: "https://evil.com" }),
      props,
      {},
      { ...ctx, props },
    );

    expect(response.status).toBe(403);
    expect(selfHostedAuthMocks.createSeoAgentMcpServer).not.toHaveBeenCalled();
  });

  it("accepts a legacy request from the SurfMind Chrome extension", async () => {
    const props = hostedProps();

    const response = await handleAuthenticatedSeoAgentMcpRequest(
      createMcpRequest({
        Origin: "chrome-extension://pghallcbnfabbgfijhbcldaapmgidnaa",
      }),
      props,
      {},
      { ...ctx, props },
    );

    expect(response.status).toBe(200);
    expect(selfHostedAuthMocks.createSeoAgentMcpServer).toHaveBeenCalledWith({
      [MCP_AUTH_CONTEXT_PROP]: {
        ...props[MCP_AUTH_CONTEXT_PROP],
        role: "owner",
      },
    });
  });

  it.each([
    [
      "the SurfMind hostname over HTTPS",
      "https://pghallcbnfabbgfijhbcldaapmgidnaa",
    ],
    [
      "another Chrome extension",
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
  ])("rejects a request from %s", async (_label, origin) => {
    const props = hostedProps();

    const response = await handleAuthenticatedSeoAgentMcpRequest(
      createMcpRequest({ Origin: origin }),
      props,
      {},
      { ...ctx, props },
    );

    expect(response.status).toBe(403);
  });

  it("rejects provider props missing the OAuth client identity", async () => {
    // Hosted tokens always carry clientId/scopes; a token without them must
    // fail closed rather than skip scope enforcement.
    const props = createWorkersOAuthMcpProps({
      userId: "user-1",
      userEmail: "user@example.com",
      organizationId: "org-1",
      baseUrl: "https://seo-agent.test",
    });

    const response = await handleAuthenticatedSeoAgentMcpRequest(
      createMcpRequest(),
      props,
      {},
      { ...ctx, props },
    );

    expect(response.status).toBe(403);
  });

  it("rejects a token whose user is no longer a member of the granted org", async () => {
    // Tokens pin organizationId at consent time; once the membership is gone
    // the token must stop working and push the client back through OAuth.
    authRepositoryMocks.getMembership.mockResolvedValue(null);
    const props = createWorkersOAuthMcpProps({
      userId: "user-1",
      userEmail: "user@example.com",
      organizationId: "org-1",
      baseUrl: "https://seo-agent.test",
      clientId: "client-1",
      scopes: ["mcp"],
    });

    const response = await handleAuthenticatedSeoAgentMcpRequest(
      createMcpRequest(),
      props,
      {},
      { ...ctx, props },
    );

    expect(response.status).toBe(401);
  });

  it("rejects an OAuth client without the MCP scope", async () => {
    const props = hostedProps(["offline_access"]);

    const response = await handleAuthenticatedSeoAgentMcpRequest(
      createMcpRequest(),
      props,
      {},
      { ...ctx, props },
    );

    expect(response.status).toBe(403);
  });
});
