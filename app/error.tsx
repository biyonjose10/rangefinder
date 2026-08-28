"use client";

import { useEffect } from "react";

/**
 * Last line of defence.
 *
 * Without this, any exception thrown while rendering takes the whole page to a
 * blank white screen with nothing to act on. That is the worst possible failure
 * for a tool being demonstrated or relied on in the field: it looks broken and
 * gives no route back.
 *
 * The APIs already degrade rather than throw — a missing forest grid costs
 * precision, an unreachable weather service costs a caveat, a failed FIRMS
 * fetch falls back to the cached snapshot. This covers what is left: an
 * unexpected shape in the data reaching the render.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Rangefinder render error:", error);
  }, [error]);

  return (
    <main className="grid min-h-screen place-items-center px-6">
      <div className="max-w-md">
        <div className="kicker mb-2">Rangefinder</div>
        <h1 className="mb-3 text-lg font-semibold">This view failed to load.</h1>
        <p className="mb-4 text-[13px] leading-relaxed text-[var(--muted)]">
          The triage pipeline itself is unaffected — the alert data, scoring and
          patrol order are served by the API and can still be reached directly.
          This is a fault in rendering the page around them.
        </p>

        <div className="mb-5 flex flex-wrap gap-2">
          <button
            onClick={reset}
            className="rounded-md bg-[var(--accent)] px-3.5 py-2 text-[13px] font-semibold text-[#06120c] transition hover:brightness-110"
          >
            Try again
          </button>
          <a
            href="/api/patrol-order"
            className="rounded-md border border-[var(--line)] px-3.5 py-2 text-[13px] font-medium text-[var(--text)] transition hover:bg-[var(--panel-2)]"
          >
            Generate patrol order anyway
          </a>
        </div>

        {error.digest && (
          <p className="mono text-[10px] text-[var(--dim)]">
            Reference: {error.digest}
          </p>
        )}
      </div>
    </main>
  );
}
