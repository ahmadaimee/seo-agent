import { env } from "cloudflare:workers";
import {
  customerHasManagedAccess,
  customerHasPaidPlan,
  getOrCreateOrganizationCustomer,
  type BillingCustomerContext,
} from "@/server/billing/subscription";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import {
  AUDIT_LIMITS,
  clampAuditMaxPages,
  getEstimatedAuditCapacity,
  type AuditLimitTier,
} from "@/server/features/audit/services/audit-capacity";
import {
  generateShareToken,
  hashSharePassword,
  issueViewToken,
  verifySharePassword,
  verifyViewToken,
} from "@/server/features/audit/services/auditShare";
import { AppError } from "@/server/lib/errors";
import { AuditProgressKV } from "@/server/lib/audit/progress-kv";
import {
  parseAuditConfig,
  type AuditConfig,
  type LighthouseStrategy,
} from "@/server/lib/audit/types";
import {
  normalizeAndValidateStartUrl,
  resolveStartUrlRedirects,
} from "@/server/lib/audit/url-policy";
import { reconcileRunningAudit } from "@/server/features/audit/services/auditReconciler";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";

// Plan-tier limits are the abuse bound in hosted mode: free accounts get small
// audits with a bounded burst, paid keeps the full limits, and customers with
// no Autumn product at all are turned away. Self-hosted isn't gated.
async function resolveAuditLimitTier(
  customer: BillingCustomerContext,
): Promise<AuditLimitTier> {
  if (!(await isHostedServerAuthMode())) return "self_hosted";
  // An org minted outside a billing path (better-auth hooks, MCP auth) has no
  // Autumn customer yet, and `check` 404s instead of reporting no access — a
  // brand-new MCP user's first audit failed with a raw billing error.
  await getOrCreateOrganizationCustomer(customer);
  const [hasManagedAccess, hasPaidPlan] = await Promise.all([
    customerHasManagedAccess(customer.organizationId),
    customerHasPaidPlan(customer.organizationId),
  ]);
  if (!hasManagedAccess) {
    throw new AppError("PAYMENT_REQUIRED", "Subscribe to run site audits");
  }
  return hasPaidPlan ? "paid" : "free";
}

async function startAudit(input: {
  actorUserId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  maxPages?: number;
  lighthouseStrategy?: LighthouseStrategy;
  limitTier: AuditLimitTier;
}) {
  const limits = AUDIT_LIMITS[input.limitTier];
  const maxPages = clampAuditMaxPages(input.maxPages);
  if (maxPages > limits.maxPagesPerAudit) {
    throw new AppError("AUDIT_PAGE_LIMIT_EXCEEDED");
  }

  const lighthouseStrategy = input.lighthouseStrategy ?? "auto";
  const reservation = getEstimatedAuditCapacity({
    maxPages,
    lighthouseStrategy,
  });

  const auditId = crypto.randomUUID();
  const config: AuditConfig = { maxPages, lighthouseStrategy };
  // Anchor the audit to the site's real origin: a start domain that 301s
  // elsewhere (…net -> …com, apex -> www) would otherwise dead-end after
  // one page at the same-origin crawl boundary.
  const startUrl = await resolveStartUrlRedirects(
    await normalizeAndValidateStartUrl(input.startUrl),
  );

  await AuditRepository.createAudit({
    id: auditId,
    projectId: input.projectId,
    startedByUserId: input.actorUserId,
    startUrl,
    workflowInstanceId: auditId,
    config,
    pagesTotal: reservation.pagesTotal,
    lighthouseTotal: reservation.lighthouseTotal,
  });

  try {
    // Concurrency and capacity are enforced after the insert, not before: a
    // pre-insert read is a check-then-act race, so parallel requests would all
    // pass the free tier's running-audits gate. Post-insert, each request sees
    // at least its own row, so racers can't all slip under the limit; the
    // losers roll back via the catch below. Racers at the boundary may all
    // abort — the user just retries. Usage counts per ORGANIZATION, not per
    // user: the free ceiling is the org's, so N members don't multiply it.
    const usage = await AuditRepository.getAuditUsageForOrganization(
      input.billingCustomer.organizationId,
    );
    if (usage.runningCount > limits.maxRunningAudits) {
      throw new AppError("AUDIT_ALREADY_RUNNING");
    }
    if (usage.capacityUnits > limits.maxCapacityUnits) {
      throw new AppError("AUDIT_CAPACITY_REACHED");
    }

    await env.SITE_AUDIT_WORKFLOW.create({
      id: auditId,
      params: {
        auditId,
        billingCustomer: {
          userId: input.billingCustomer.userId,
          userEmail: input.billingCustomer.userEmail,
          organizationId: input.billingCustomer.organizationId,
          projectId: input.billingCustomer.projectId,
        },
        projectId: input.projectId,
        startUrl,
        config,
      },
    });
  } catch (error) {
    try {
      const instance = await env.SITE_AUDIT_WORKFLOW.get(auditId);
      await instance.terminate();
    } catch {
      // The workflow may never have been created, or may already be gone.
    }

    await AuditRepository.deleteAuditForProject(auditId, input.projectId);
    throw error;
  }

  return { auditId };
}

async function getStatus(auditId: string, projectId: string) {
  let audit = await AuditRepository.getAuditForProject(auditId, projectId);
  if (!audit)
    throw new AppError("NOT_FOUND", "Audit not found in this project.");

  // Self-heal audits whose workflow died without reaching the mark-failed
  // step (instance terminated/errored, instance expired from retention, ...).
  // Without this they stay "running" forever and hold capacity.
  if (audit.status === "running") {
    const reconciled = await reconcileRunningAudit(audit);
    if (reconciled) {
      audit =
        (await AuditRepository.getAuditForProject(auditId, projectId)) ?? audit;
    }
  }

  return {
    id: audit.id,
    startUrl: audit.startUrl,
    status: audit.status,
    pagesCrawled: audit.pagesCrawled,
    pagesTotal: audit.pagesTotal,
    lighthouseTotal: audit.lighthouseTotal,
    lighthouseCompleted: audit.lighthouseCompleted,
    lighthouseFailed: audit.lighthouseFailed,
    currentPhase: audit.currentPhase,
    errorCode: audit.errorCode,
    startedAt: audit.startedAt,
    completedAt: audit.completedAt,
  };
}

async function getResults(auditId: string, projectId: string) {
  const { audit, pages, lighthouse, issues } =
    await AuditRepository.getAuditResultsForProject(auditId, projectId);

  if (!audit) throw new AppError("NOT_FOUND");

  const parsedConfig = parseAuditConfig(audit.config);
  if (!parsedConfig) {
    throw new AppError("INTERNAL_ERROR", "Invalid audit configuration");
  }

  return {
    audit: {
      id: audit.id,
      startUrl: audit.startUrl,
      status: audit.status,
      pagesCrawled: audit.pagesCrawled,
      pagesTotal: audit.pagesTotal,
      startedAt: audit.startedAt,
      completedAt: audit.completedAt,
      config: parsedConfig,
    },
    pages,
    lighthouse,
    issues,
  };
}

/** The share state the results page shows beside its share button. */
async function getShareState(auditId: string, projectId: string) {
  const audit = await AuditRepository.getAuditForProject(auditId, projectId);
  if (!audit) throw new AppError("NOT_FOUND");
  return {
    shareToken: audit.shareToken,
    hasPassword: audit.sharePasswordHash !== null,
    sharedAt: audit.shareCreatedAt,
  };
}

/**
 * Mint (or replace) an audit's share link. Always issues a fresh token, so
 * "create a new link" is also how a user retires one they sent to the wrong
 * person.
 */
async function createShareLink(input: {
  auditId: string;
  projectId: string;
  password?: string | null;
}) {
  const audit = await AuditRepository.getAuditForProject(
    input.auditId,
    input.projectId,
  );
  if (!audit) throw new AppError("NOT_FOUND");
  if (audit.status === "running") {
    throw new AppError(
      "CONFLICT",
      "Wait for the audit to finish before sharing it.",
    );
  }

  const password = input.password?.trim();
  const shareToken = generateShareToken();
  const share = {
    shareToken,
    sharePasswordHash: password ? await hashSharePassword(password) : null,
    shareCreatedAt: new Date().toISOString(),
  };
  await AuditRepository.setAuditShare(input.auditId, input.projectId, share);

  return {
    shareToken,
    hasPassword: share.sharePasswordHash !== null,
    sharedAt: share.shareCreatedAt,
  };
}

async function revokeShareLink(auditId: string, projectId: string) {
  const audit = await AuditRepository.getAuditForProject(auditId, projectId);
  if (!audit) throw new AppError("NOT_FOUND");
  await AuditRepository.setAuditShare(auditId, projectId, {
    shareToken: null,
    sharePasswordHash: null,
    shareCreatedAt: null,
  });
}

type SharedReportResult =
  | { state: "not-found" }
  | { state: "password-required"; wrongPassword: boolean }
  | {
      state: "ok";
      viewToken: string | null;
      report: Awaited<ReturnType<typeof buildSharedReport>>;
    };

/**
 * Resolve a share link into its report. Unauthenticated by design — the token
 * is the credential — so it never takes a project id and never reveals whether
 * a token exists beyond "not found".
 */
async function getSharedReport(input: {
  shareToken: string;
  password?: string | null;
  viewToken?: string | null;
}): Promise<SharedReportResult> {
  const audit = await AuditRepository.getAuditByShareToken(input.shareToken);
  // A revoked link clears the token, so this also covers "used to work".
  if (!audit?.shareToken) return { state: "not-found" };

  if (!audit.sharePasswordHash) {
    return { state: "ok", viewToken: null, report: await buildSharedReport(audit) };
  }

  const unlocked =
    (input.viewToken
      ? await verifyViewToken(
          input.viewToken,
          audit.shareToken,
          audit.sharePasswordHash,
        )
      : false) ||
    (input.password
      ? await verifySharePassword(input.password, audit.sharePasswordHash)
      : false);

  if (!unlocked) {
    return {
      state: "password-required",
      // Distinguishes "type a password" from "that password was wrong"
      // without telling an unprompted visitor anything either way.
      wrongPassword: Boolean(input.password),
    };
  }

  return {
    state: "ok",
    viewToken: await issueViewToken(audit.shareToken, audit.sharePasswordHash),
    report: await buildSharedReport(audit),
  };
}

type ShareableAudit = NonNullable<
  Awaited<ReturnType<typeof AuditRepository.getAuditByShareToken>>
>;

async function buildSharedReport(audit: ShareableAudit) {
  const { pages, lighthouse, issues } =
    await AuditRepository.getAuditResultsById(audit.id);

  return {
    // R2 keys embed the project and audit ids and are an internal storage
    // detail; the report only needs to know a screenshot exists, and fetches
    // it back through the share-authorized endpoint.
    lighthouse: lighthouse.map(({ r2Key: _r2Key, screenshotR2Key, ...row }) => ({
      ...row,
      hasScreenshot: screenshotR2Key !== null,
    })),
    audit: {
      id: audit.id,
      startUrl: audit.startUrl,
      status: audit.status,
      pagesCrawled: audit.pagesCrawled,
      pagesTotal: audit.pagesTotal,
      startedAt: audit.startedAt,
      completedAt: audit.completedAt,
      config: parseAuditConfig(audit.config),
    },
    pages,
    issues,
  };
}

/**
 * Whether a share token (plus, when the link has a password, a live view
 * token) authorizes reading this audit's assets. Screenshots are fetched by
 * the browser, which cannot carry the password.
 */
async function authorizeSharedAsset(input: {
  shareToken: string;
  viewToken?: string | null;
}): Promise<{ auditId: string } | null> {
  const audit = await AuditRepository.getAuditByShareToken(input.shareToken);
  if (!audit?.shareToken) return null;
  if (!audit.sharePasswordHash) return { auditId: audit.id };
  if (!input.viewToken) return null;
  const valid = await verifyViewToken(
    input.viewToken,
    audit.shareToken,
    audit.sharePasswordHash,
  );
  return valid ? { auditId: audit.id } : null;
}

async function getHistory(projectId: string) {
  const auditList = await AuditRepository.getAuditsByProject(projectId);

  return auditList.map((audit) => {
    const parsedConfig = parseAuditConfig(audit.config);
    const ranLighthouse = parsedConfig?.lighthouseStrategy !== "none";

    return {
      id: audit.id,
      startUrl: audit.startUrl,
      status: audit.status,
      pagesCrawled: audit.pagesCrawled,
      pagesTotal: audit.pagesTotal,
      ranLighthouse,
      startedAt: audit.startedAt,
      completedAt: audit.completedAt,
    };
  });
}

async function getCrawlProgress(auditId: string, projectId: string) {
  const audit = await AuditRepository.getAuditForProject(auditId, projectId);
  if (!audit) {
    throw new AppError("NOT_FOUND");
  }

  return AuditProgressKV.getCrawledUrls(auditId);
}

async function remove(auditId: string, projectId: string) {
  const audit = await AuditRepository.getAuditForProject(auditId, projectId);
  if (!audit) {
    throw new AppError("NOT_FOUND");
  }

  if (audit.status === "running") {
    if (!audit.workflowInstanceId) {
      throw new AppError(
        "CONFLICT",
        "Cannot delete a running audit without workflow context.",
      );
    }

    // A row can be "running" with no live workflow instance if a start failed
    // between the row insert and workflow creation and its rollback delete
    // also failed. Nothing to terminate then — deleting the row is the fix.
    const instance = await env.SITE_AUDIT_WORKFLOW.get(
      audit.workflowInstanceId,
    ).catch(() => null);
    try {
      await instance?.terminate();
    } catch (error) {
      // terminate() throws when the instance already reached a terminal state
      // (it completed or errored in the moment before the user hit stop). That
      // race shouldn't block deletion — re-check the live status and only fail
      // if the workflow is genuinely still running.
      const status = await instance?.status().catch(() => null);
      const stillRunning =
        status != null &&
        ["queued", "running", "paused", "waiting", "waitingForPause"].includes(
          status.status,
        );
      if (stillRunning) {
        console.error(`Failed to terminate audit workflow ${audit.id}:`, error);
        throw new AppError("CONFLICT", "Unable to stop the running audit.");
      }
    }
  }

  await AuditRepository.deleteAuditForProject(auditId, projectId);
  // Best-effort: drop the crawl scratchpad DO with the audit (it lives in
  // the seo-agent-audit worker, behind the AuditEngine RPC). A missed destroy
  // self-cleans via the DO's 7-day alarm.
  try {
    await env.AUDIT_ENGINE.destroyScratchpad(auditId);
  } catch (error) {
    console.warn(`Failed to destroy audit scratchpad ${auditId}:`, error);
  }
}

export const AuditService = {
  resolveAuditLimitTier,
  startAudit,
  getStatus,
  getCrawlProgress,
  getResults,
  getShareState,
  createShareLink,
  revokeShareLink,
  getSharedReport,
  authorizeSharedAsset,
  getHistory,
  remove,
} as const;
