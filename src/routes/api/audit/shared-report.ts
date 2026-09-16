import { createFileRoute } from "@tanstack/react-router";
import { handleSharedReportRequest } from "@/server/features/audit/services/sharedReportEndpoint";

export const Route = createFileRoute("/api/audit/shared-report")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        handleSharedReportRequest(request),
    },
  },
});
