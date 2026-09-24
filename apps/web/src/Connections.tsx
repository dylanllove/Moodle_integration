import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, type Health, type HealthCheck } from "./api.js";
import { Badge, Button, Card, SectionTitle } from "./ui.js";

/**
 * Whether each thing the app depends on is actually working.
 *
 * Every row here comes from a real request the server just made, not from
 * "is there a key in the settings" — a revoked Moodle token used to show as
 * connected while lectures quietly stopped arriving.
 */
/** Fired whenever a connection may have changed — a check, a sign-in. */
export const CONNECTIONS_CHANGED = "uni:connections";

export function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);
  const { pathname } = useLocation();
  const load = useCallback(async () => setHealth(await api.connections().catch(() => null)), []);
  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      setHealth(await api.connectionsCheck());
      // The banner and the Settings card each hold a copy; keep them in step.
      window.dispatchEvent(new Event(CONNECTIONS_CHANGED));
    } catch {
      /* keep what we had */
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    // A sync is when connections are exercised; a sign-in is when they're fixed.
    window.addEventListener("uni:synced", load);
    window.addEventListener(CONNECTIONS_CHANGED, load);
    return () => {
      window.removeEventListener("uni:synced", load);
      window.removeEventListener(CONNECTIONS_CHANGED, load);
    };
  }, [load]);
  // And on every page change: coming back from setup after signing in should
  // show the fix, not the stale warning. The server answers from its cache.
  useEffect(() => {
    load();
  }, [load, pathname]);
  return { health, checking, checkNow, reload: load };
}

const TONE: Record<HealthCheck["state"], "green" | "red" | "amber" | "neutral"> = {
  ok: "green",
  broken: "red",
  missing: "amber",
  optional: "neutral",
};
const WORD: Record<HealthCheck["state"], string> = {
  ok: "working",
  broken: "needs attention",
  missing: "not set up",
  optional: "optional",
};

export function ConnectionsCard() {
  const { health, checking, checkNow } = useHealth();
  return (
    <Card className="p-6">
      <SectionTitle
        className="mb-1.5"
        action={
          <Button size="sm" onClick={checkNow} disabled={checking}>
            {checking ? "Checking…" : "Check connections"}
          </Button>
        }
      >
        Connections
      </SectionTitle>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        Each one is tested live.{" "}
        {health && `Last checked ${new Date(health.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`}
      </p>
      {!health ? (
        <p className="text-[13px] text-ink-muted">Checking…</p>
      ) : (
        <div className="divide-y divide-hair">
          {health.checks.map((c) => (
            <div key={c.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-3">
              <span className="w-44 shrink-0 text-[13px] font-medium text-ink">{c.label}</span>
              <Badge tone={TONE[c.state]}>{WORD[c.state]}</Badge>
              <div className="min-w-0 flex-1 basis-60 text-[13px] leading-relaxed text-ink-muted">
                {c.detail}
                {c.fix && c.state !== "ok" && (
                  <span className="block text-ink">
                    {c.fix}{" "}
                    {c.to && (
                      <Link className="font-semibold text-accent-deep hover:underline" to={c.to}>
                        Go →
                      </Link>
                    )}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * The one line at the top of every page when something the app needs has
 * stopped working — named, with the fix, instead of lectures silently not
 * arriving. Only for things that are broken; "not set up yet" belongs to setup.
 */
export function ConnectionBanner() {
  const { health, checking, checkNow } = useHealth();
  const broken = health?.checks.filter((c) => c.state === "broken") ?? [];
  if (!broken.length) return null;
  return (
    <div className="mb-8 rounded-card border border-rose-200 bg-rose-50 px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          {broken.map((c) => (
            <div key={c.key}>
              <div className="text-sm font-semibold text-rose-900">{c.label}: {c.detail}</div>
              {c.fix && <p className="mt-0.5 text-[13px] leading-relaxed text-rose-900/80">{c.fix}</p>}
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {broken[0]?.to && (
            <Link to={broken[0].to}>
              <Button size="sm">Fix it</Button>
            </Link>
          )}
          <Button size="sm" onClick={checkNow} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </Button>
        </div>
      </div>
    </div>
  );
}
