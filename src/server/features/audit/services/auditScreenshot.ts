/**
 * Serving for Lighthouse screenshots.
 *
 * Two callers can read one: a signed-in member of the project that owns the
 * audit, and a holder of the audit's share link. The R2 key is never accepted
 * from the client — it is looked up from the audit row — so neither path can
 * be walked into another tenant's objects.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLighthouseResults, audits } from "@/db/schema";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { getObjectFromR2 } from "@/server/lib/r2";

type Strategy = "mobile" | "desktop";

const STRATEGIES: readonly Strategy[] = ["mobile", "desktop"];

function parseStrategy(value: string | null): Strategy | null {
  return STRATEGIES.find((strategy) => strategy === value) ?? null;
}

function notFound(): Response {
  // One response for "no such audit", "not yours" and "no screenshot": a
  // public endpoint should not confirm which audits exist.
  return new Response("Not found", { status: 404 });
}

/** Look up the stored screenshot key for one Lighthouse run. */
async function findScreenshotKey(
  auditId: string,
  pageId: string,
  strategy: Strategy,
): Promise<string | null> {
  const row = await db
    .select({ screenshotR2Key: auditLighthouseResults.screenshotR2Key })
    .from(auditLighthouseResults)
    .where(
      and(
        eq(auditLighthouseResults.auditId, auditId),
        eq(auditLighthouseResults.pageId, pageId),
        eq(auditLighthouseResults.strategy, strategy),
      ),
    )
    .limit(1);
  return row[0]?.screenshotR2Key ?? null;
}

/** Is the caller a member of the organization that owns this audit? */
async function authorizeSignedInViewer(
  request: Request,
  auditId: string,
): Promise<boolean> {
  let context;
  try {
    context = await resolveUserContextFromHeaders(request.headers);
  } catch {
    return false;
  }
  const audit = await db.query.audits.findFirst({
    where: eq(audits.id, auditId),
  });
  if (!audit) return false;
  const project = await ProjectRepository.getProjectForOrganization(
    audit.projectId,
    context.organizationId,
  );
  return project !== null && project !== undefined;
}

export async function handleAuditScreenshotRequest(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const auditId = url.searchParams.get("auditId");
  const pageId = url.searchParams.get("pageId");
  const strategy = parseStrategy(url.searchParams.get("strategy"));
  if (!auditId || !pageId || !strategy) {
    return notFound();
  }

  const shareToken = url.searchParams.get("share");
  const authorized = shareToken
    ? (
        await AuditService.authorizeSharedAsset({
          shareToken,
          viewToken: url.searchParams.get("view"),
        })
      )?.auditId === auditId
    : await authorizeSignedInViewer(request, auditId);
  if (!authorized) return notFound();

  const key = await findScreenshotKey(auditId, pageId, strategy);
  if (!key) return notFound();

  const object = await getObjectFromR2(key);
  if (!object) return notFound();

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
      // An audit's screenshots are written once and never change. Private,
      // because the URL carries the credential.
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Length": String(object.size),
    },
  });
}
