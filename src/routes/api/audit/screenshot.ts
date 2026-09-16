import { createFileRoute } from "@tanstack/react-router";
import { handleAuditScreenshotRequest } from "@/server/features/audit/services/auditScreenshot";

export const Route = createFileRoute("/api/audit/screenshot")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        handleAuditScreenshotRequest(request),
    },
  },
});
