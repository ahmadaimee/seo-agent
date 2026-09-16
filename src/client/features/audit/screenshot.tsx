import { useState } from "react";

/**
 * Lighthouse screenshots for both audit surfaces: the in-app performance table
 * and the read-only shared report. The endpoint authorizes on either the
 * viewer's session or the share token, so the only difference between the two
 * callers is whether they pass share credentials.
 */

export function screenshotUrl(input: {
  auditId: string;
  pageId: string;
  strategy: string;
  shareToken?: string;
  viewToken?: string | null;
}): string {
  const params = new URLSearchParams({
    auditId: input.auditId,
    pageId: input.pageId,
    strategy: input.strategy,
  });
  if (input.shareToken) params.set("share", input.shareToken);
  if (input.viewToken) params.set("view", input.viewToken);
  return `/api/audit/screenshot?${params.toString()}`;
}

/** Thumbnail that opens the full-size capture in a dialog. */
export function ScreenshotThumbnail({
  src,
  alt,
}: {
  src: string;
  alt: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-16 overflow-hidden rounded border border-base-300 transition hover:border-primary"
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="h-12 w-full object-cover object-top"
        />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={() => setOpen(false)}
        >
          <img
            src={src}
            alt={alt}
            className="max-w-3xl rounded-box border border-base-300 bg-base-100"
          />
        </div>
      )}
    </>
  );
}
