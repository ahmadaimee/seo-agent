/**
 * HTTP entry point for reading a shared audit report.
 *
 * The report page's loader reaches the service through a server function,
 * which is fine because it runs during SSR. The password form cannot: server
 * functions POST to /_serverFn, which sits behind the self-host Basic-auth
 * guard, and the whole point of a share link is that its recipient has no
 * workspace credentials. This route is on the guard's allow list instead, and
 * authorizes on the share token and password alone.
 */
import { AuditService } from "@/server/features/audit/services/AuditService";
import { getSharedAuditReportSchema } from "@/types/schemas/audit";

export type SharedReportEndpointResult = Awaited<
  ReturnType<typeof AuditService.getSharedReport>
>;

export async function handleSharedReportRequest(
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ state: "not-found" }, { status: 400 });
  }

  const parsed = getSharedAuditReportSchema.safeParse(body);
  if (!parsed.success) {
    // Same shape as a genuine miss: a malformed token should look no different
    // from an unknown one.
    return Response.json({ state: "not-found" });
  }

  const result = await AuditService.getSharedReport({
    shareToken: parsed.data.shareToken,
    password: parsed.data.password ?? null,
    viewToken: parsed.data.viewToken ?? null,
  });

  return Response.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
