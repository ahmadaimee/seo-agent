import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  createAuditShareLink,
  getAuditShareState,
  revokeAuditShareLink,
} from "@/serverFunctions/auditShare";

/**
 * Creates the read-only link an audit is shared with. Sits beside Export
 * because that is where someone goes when they want to send the report to
 * someone who cannot open the app.
 */
export function ShareLinkButton({
  auditId,
  projectId,
  disabled,
}: {
  auditId: string;
  projectId: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-ghost gap-1"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Link2 className="size-4" />
        Share
      </button>
      {open && (
        <ShareDialog
          auditId={auditId}
          projectId={projectId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ShareDialog({
  auditId,
  projectId,
  onClose,
}: {
  auditId: string;
  projectId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["audit-share", projectId, auditId];
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);

  const shareState = useQuery({
    queryKey,
    queryFn: () => getAuditShareState({ data: { projectId, auditId } }),
  });

  const create = useMutation({
    mutationFn: () =>
      createAuditShareLink({
        data: {
          projectId,
          auditId,
          password: usePassword && password ? password : null,
        },
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
      setPassword("");
    },
    onError: () => toast.error("Could not create the share link."),
  });

  const revoke = useMutation({
    mutationFn: () => revokeAuditShareLink({ data: { projectId, auditId } }),
    onSuccess: () => {
      queryClient.setQueryData(queryKey, {
        shareToken: null,
        hasPassword: false,
        sharedAt: null,
      });
      toast.success("Share link revoked.");
    },
    onError: () => toast.error("Could not revoke the share link."),
  });

  const token = shareState.data?.shareToken ?? null;
  const shareUrl = token
    ? `${globalThis.location?.origin ?? ""}/r/${token}`
    : null;

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy. Select the link and copy it manually.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Share this report"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-box border border-base-300 bg-base-100 p-5">
        <h2 className="text-lg font-semibold">Share this report</h2>
        <p className="mt-1 text-sm text-base-content/60">
          Anyone with the link can read the report. They cannot sign in, change
          anything, or see the rest of the workspace.
        </p>

        {shareState.isLoading ? (
          <div className="mt-6 flex justify-center">
            <Loader2 className="size-5 animate-spin text-base-content/40" />
          </div>
        ) : shareUrl ? (
          <div className="mt-4 space-y-3">
            <div className="flex gap-2">
              <input
                readOnly
                value={shareUrl}
                onFocus={(event) => event.currentTarget.select()}
                className="input input-bordered input-sm w-full font-mono text-xs"
              />
              <button
                type="button"
                className="btn btn-sm btn-primary gap-1"
                onClick={() => void copy()}
              >
                {copied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-xs text-base-content/50">
              {shareState.data?.hasPassword
                ? "Protected with a password. Send it separately from the link."
                : "No password — the link alone opens the report."}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate()}
              >
                Revoke link
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={create.isPending}
                onClick={() => create.mutate()}
              >
                Replace with a new link
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={usePassword}
                onChange={(event) => setUsePassword(event.target.checked)}
              />
              Require a password
            </label>
            {usePassword && (
              <input
                type="text"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 4 characters"
                className="input input-bordered input-sm w-full"
              />
            )}
            <button
              type="button"
              className="btn btn-sm btn-primary w-full"
              disabled={
                create.isPending ||
                (usePassword && password.trim().length < 4)
              }
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create share link"}
            </button>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
