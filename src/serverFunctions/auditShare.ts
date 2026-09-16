import { createServerFn } from "@tanstack/react-start";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  auditShareStateSchema,
  createAuditShareLinkSchema,
  getSharedAuditReportSchema,
  revokeAuditShareLinkSchema,
} from "@/types/schemas/audit";

export const getAuditShareState = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(auditShareStateSchema)
  .handler(async ({ data, context }) => {
    return AuditService.getShareState(data.auditId, context.projectId);
  });

export const createAuditShareLink = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(createAuditShareLinkSchema)
  .handler(async ({ data, context }) => {
    // Publishing an audit outside the workspace is a share of the whole
    // project's crawl data, so it takes the same gate as the other
    // outward-facing project actions.
    requireOrgPermission(context, { project: ["share"] });
    return AuditService.createShareLink({
      auditId: data.auditId,
      projectId: context.projectId,
      password: data.password ?? null,
    });
  });

export const revokeAuditShareLink = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(revokeAuditShareLinkSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { project: ["share"] });
    await AuditService.revokeShareLink(data.auditId, context.projectId);
    return { success: true };
  });

/**
 * Deliberately unauthenticated: the share token in the URL is the credential,
 * and the optional password is checked inside the service. Runs without the
 * project middleware so a recipient with no account can open the report.
 */
export const getSharedAuditReport = createServerFn({ method: "POST" })
  .validator(getSharedAuditReportSchema)
  .handler(async ({ data }) => {
    return AuditService.getSharedReport({
      shareToken: data.shareToken,
      password: data.password ?? null,
      viewToken: data.viewToken ?? null,
    });
  });
