import { useCallback, useEffect, useState } from "react";
import {
  api,
  type NotionDirection,
  type NotionLink,
  type NotionLinkKind,
  type NotionStatus,
  type NotionSuggestion,
  type NotionTarget,
} from "./api.js";
import { Badge, Button, Card, Details, Input, Notice, SectionTitle, Select } from "./ui.js";

/**
 * Notion setup.
 *
 * The old version was a secret box and a URL box, and it failed at the URL box —
 * so this one asks for the secret and then *shows you what it can see*, because
 * Notion will happily list the pages you've shared with an integration. Choosing
 * from a list can't be mistyped, and it makes the "did I actually share it?" step
 * visible instead of a mystery.
 */
const KIND_LABEL: Record<NotionLinkKind, string> = {
  assessments: "Assessments & deadlines",
  notes: "Lecture notes",
};

const DIRECTIONS: { value: NotionDirection; label: string; hint: string }[] = [
  { value: "both", label: "Both ways", hint: "your edits come back, ours go out" },
  { value: "push", label: "Only send", hint: "Notion mirrors the app" },
  { value: "pull", label: "Only read", hint: "the app reads Notion, never writes" },
];

export function NotionSettings() {
  const [status, setStatus] = useState<NotionStatus | null>(null);
  const [inv, setInv] = useState<{ pages: NotionTarget[]; databases: NotionTarget[] } | null>(null);
  const [suggestions, setSuggestions] = useState<NotionSuggestion[]>([]);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "info" | "warn" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const s = await api.notionStatus().catch(() => null);
    setStatus(s);
    if (s?.configured) {
      await Promise.all([
        api
          .notionInventory()
          .then((r) => setInv({ pages: r.pages, databases: r.databases }))
          .catch(() => {}),
        api
          .notionSuggest()
          .then((r) => setSuggestions(r.suggestions))
          .catch(() => {}),
      ]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function saveToken() {
    setBusy("token");
    setMsg(null);
    try {
      const r = await api.notionToken(token.trim());
      setToken("");
      setInv({ pages: r.pages, databases: r.databases });
      setMsg({
        tone: "info",
        text: `Connected as “${r.name}”. It can see ${r.pages.length} page${r.pages.length === 1 ? "" : "s"} and ${r.databases.length} database${r.databases.length === 1 ? "" : "s"} — pick where things should go below.`,
      });
      await load();
    } catch (e) {
      setMsg({ tone: "error", text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(null);
    }
  }

  async function run<T>(key: string, fn: () => Promise<T>, ok: (r: T) => string) {
    setBusy(key);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ tone: "info", text: ok(r) });
      await load();
    } catch (e) {
      setMsg({ tone: "error", text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(null);
    }
  }

  if (!status) return null;

  return (
    <Card className="p-6">
      <SectionTitle
        className="mb-1.5"
        action={
          status.connected && (
            <Button
              size="sm"
              disabled={busy === "sync"}
              onClick={() =>
                run("sync", api.notionSync, (r) =>
                  `Sent ${r.created} new and updated ${r.updated}${r.archived ? `, tidied ${r.archived}` : ""}; read ${r.pulled} back from Notion.`,
                )
              }
            >
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </Button>
          )
        }
      >
        Notion
      </SectionTitle>
      <p className="mb-5 text-[13px] leading-relaxed text-ink-muted">
        Works in both directions and writes into the databases you already keep, matching their
        columns rather than adding its own. Weightings and marks you type in Notion come back to the
        grade calculator; lecture notes and deadlines go out.
      </p>

      {msg && (
        <Notice tone={msg.tone} className="mb-5">
          {msg.text}
        </Notice>
      )}

      {!status.configured ? (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            Create an integration at{" "}
            <a
              className="font-medium text-accent-deep hover:underline"
              href="https://www.notion.so/my-integrations"
              target="_blank"
              rel="noreferrer"
            >
              notion.so/my-integrations ↗
            </a>
            , copy its secret, then share the pages you want it to touch (open a page → ••• →
            Connections → your integration).
          </p>
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[18rem] flex-1">
              <Input
                density="sm"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ntn_… (integration secret)"
                aria-label="Notion integration secret"
              />
            </div>
            <Button variant="primary" size="sm" disabled={!token.trim() || busy === "token"} onClick={saveToken}>
              {busy === "token" ? "Checking…" : "Connect"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <ParentPicker
            pages={inv?.pages ?? []}
            current={status.parentPage}
            busy={busy === "parent"}
            onPick={(page) =>
              run("parent", () => api.notionSetParent(page), () => "Saved — new databases will be created there.")
            }
          />

          {suggestions.length > 0 && status.links.length === 0 && (
            <Details summary={`${suggestions.length} database${suggestions.length === 1 ? "" : "s"} in your Notion look usable`}>
              <ul className="space-y-1.5 pt-1">
                {suggestions.map((s) => (
                  <li key={s.notion_id} className="text-[13px] leading-snug text-ink-muted">
                    <strong className="font-medium text-ink">{s.title}</strong> — {s.because}
                  </li>
                ))}
              </ul>
            </Details>
          )}

          <div className="space-y-4">
            {(["assessments", "notes"] as NotionLinkKind[]).map((kind) => (
              <KindSection
                key={kind}
                kind={kind}
                status={status}
                databases={inv?.databases ?? []}
                busy={busy}
                onRun={run}
              />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function ParentPicker({
  pages,
  current,
  busy,
  onPick,
}: {
  pages: NotionTarget[];
  current: string | null;
  busy: boolean;
  onPick: (page: string) => void;
}) {
  const [manual, setManual] = useState("");
  const currentPage = pages.find((p) => p.id === current);
  return (
    <div className="rounded-field border border-hair p-4">
      <div className="mb-1 text-[13px] font-medium text-ink">Where new databases go</div>
      <p className="mb-3 text-[12px] leading-relaxed text-ink-muted">
        Notion doesn't let an integration create anything at the top level, so anything the app has
        to make needs a home page. {currentPage ? `Currently “${currentPage.title}”.` : ""}
      </p>
      {pages.length > 0 ? (
        <div className="w-full max-w-sm">
          <Select
            density="sm"
            value={current ?? ""}
            disabled={busy}
            onChange={(e) => e.target.value && onPick(e.target.value)}
            aria-label="Parent page for new databases"
          >
            <option value="">Choose a page…</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <div className="min-w-[16rem] flex-1">
            <Input
              density="sm"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Paste a Notion page link"
              aria-label="Notion page link"
            />
          </div>
          <Button size="sm" disabled={!manual.trim() || busy} onClick={() => onPick(manual.trim())}>
            Use this page
          </Button>
        </div>
      )}
      {pages.length === 0 && (
        <p className="mt-2 text-[12px] text-ink-muted">
          Nothing shared with the integration yet — open a page in Notion, ••• → Connections, and add
          it.
        </p>
      )}
    </div>
  );
}

/**
 * One block per kind of thing, listing every course. A course with no mapping is
 * the normal starting state, not an error, so it reads as an offer rather than a
 * warning.
 */
function KindSection({
  kind,
  status,
  databases,
  busy,
  onRun,
}: {
  kind: NotionLinkKind;
  status: NotionStatus;
  databases: NotionTarget[];
  busy: string | null;
  onRun: <T>(key: string, fn: () => Promise<T>, ok: (r: T) => string) => Promise<void>;
}) {
  // Databases whose shape matches come first; the rest stay selectable, because
  // our guess about someone else's table is not the last word.
  const sorted = [...databases].sort((a, b) => {
    const rank = (t: NotionTarget) => (t.shape === kind ? 0 : t.shape === "unknown" ? 1 : 2);
    return rank(a) - rank(b) || a.title.localeCompare(b.title);
  });
  const rows: { id: string | null; label: string }[] = [
    { id: null, label: "Everything not listed below" },
    ...status.courses.map((c) => ({ id: c.id, label: c.code ?? c.name })),
  ];

  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
        {KIND_LABEL[kind]}
      </div>
      <div className="divide-y divide-hair rounded-field border border-hair">
        {rows.map((row) => {
          const link = status.links.find((l) => l.kind === kind && l.course_id === row.id) ?? null;
          return (
            <LinkRow
              key={`${kind}:${row.id ?? "all"}`}
              kind={kind}
              courseId={row.id}
              label={row.label}
              link={link}
              databases={sorted}
              busy={busy}
              onRun={onRun}
            />
          );
        })}
      </div>
    </div>
  );
}

function LinkRow({
  kind,
  courseId,
  label,
  link,
  databases,
  busy,
  onRun,
}: {
  kind: NotionLinkKind;
  courseId: string | null;
  label: string;
  link: NotionLink | null;
  databases: NotionTarget[];
  busy: string | null;
  onRun: <T>(key: string, fn: () => Promise<T>, ok: (r: T) => string) => Promise<void>;
}) {
  const key = `${kind}:${courseId ?? "all"}`;
  const working = busy === key;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
      <span className="min-w-[8rem] flex-1 text-[13px] font-medium text-ink">{label}</span>

      <div className="w-56">
        <Select
          density="sm"
          value={link?.notion_id ?? ""}
          disabled={working}
          aria-label={`Notion database for ${label}`}
          onChange={(e) => {
            const value = e.target.value;
            if (!value) {
              if (link) void onRun(key, () => api.notionUnlink(link.id), () => `${label} unlinked.`);
              return;
            }
            void onRun(
              key,
              () => api.notionLink({ course_id: courseId, kind, notion: value }),
              (r) => `${label} → “${r.link.title}”.`,
            );
          }}
        >
          <option value="">Not synced</option>
          {databases.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
              {d.shape === kind ? " ✓" : ""}
            </option>
          ))}
        </Select>
      </div>

      {link ? (
        <>
          <div className="w-32">
            <Select
              density="sm"
              value={link.direction}
              disabled={working}
              aria-label={`Sync direction for ${label}`}
              onChange={(e) =>
                void onRun(
                  key,
                  () =>
                    api.notionLink({
                      course_id: courseId,
                      kind,
                      notion: link.notion_id,
                      direction: e.target.value as NotionDirection,
                    }),
                  () => `${label} set to ${e.target.value === "both" ? "both ways" : e.target.value}.`,
                )
              }
            >
              {DIRECTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </Select>
          </div>
          {link.notion_url && (
            <a
              href={link.notion_url}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] font-medium text-accent-deep hover:underline"
            >
              Open ↗
            </a>
          )}
          {link.last_pull && <Badge tone="green">two-way</Badge>}
        </>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={working}
          onClick={() =>
            void onRun(
              key,
              () => api.notionCreateDatabase({ course_id: courseId, kind }),
              (r) => `Created “${r.link.title}” in Notion.`,
            )
          }
        >
          {working ? "…" : "Make one"}
        </Button>
      )}
    </div>
  );
}
