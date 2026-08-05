import { useCallback, useEffect, useState } from "react";
import { api, type AiStatus } from "./api.js";
import { Badge, Button, Card, Details, Input, Notice, SectionTitle, Segmented } from "./ui.js";

/**
 * What the AI costs, and how to stop paying for it.
 *
 * A local tool that quietly bills per lecture is a tool you switch off. Two
 * things drive the bill — transcribing audio and generating text — and both can
 * run on this machine for nothing, so the job of this panel is to say what's
 * being spent, on what, and offer the free path for each.
 */
const PROVIDERS = ["auto", "local", "openai"] as const;
const PROVIDER_LABEL: Record<string, string> = {
  auto: "Auto",
  local: "Local only",
  openai: "OpenAI only",
};

export function AiSettings() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const s = await api.aiStatus().catch(() => null);
    setStatus(s);
    if (s?.budgetUsd != null) setBudget(String(s.budgetUsd));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function save(body: Parameters<typeof api.aiOptions>[0], note?: string) {
    setBusy("save");
    setMsg(null);
    try {
      await api.aiOptions(body);
      if (note) setMsg(note);
      await load();
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }

  if (!status) return null;
  const { spend, local, cache } = status;
  const textFree = local.text.ok;
  const audioFree = local.audio.ok;

  return (
    <Card className="p-6">
      <SectionTitle
        className="mb-1.5"
        action={
          <Button
            size="sm"
            disabled={busy === "probe"}
            onClick={async () => {
              setBusy("probe");
              await api.aiProbeLocal().catch(() => {});
              await load();
              setBusy(null);
            }}
          >
            {busy === "probe" ? "Checking…" : "Check for local models"}
          </Button>
        }
      >
        AI cost
      </SectionTitle>
      <p className="mb-5 text-[13px] leading-relaxed text-ink-muted">
        Transcribing lectures is the biggest expense — around{" "}
        <strong className="font-semibold text-ink">$0.006 a minute</strong>, so a semester of
        recordings runs to real money. Both halves of the work can run on this machine instead, at no
        cost and with nothing leaving it.
      </p>

      {msg && <Notice className="mb-5">{msg}</Notice>}

      {/* Spend first: the number is the reason anyone reads this panel. */}
      <div className="mb-5 flex flex-wrap gap-6 rounded-field border border-hair p-4">
        <Figure label="This month" value={money(spend.monthUsd)} />
        <Figure label="Today" value={money(spend.todayUsd)} />
        <Figure
          label="Saved by caching"
          value={money(cache.savedUsd)}
          hint={`${cache.entries} answers kept`}
        />
      </div>

      {spend.byTask.length > 0 && (
        <Details summary="What it went on" className="mb-5">
          <div className="space-y-1 pt-1">
            {spend.byTask.map((t) => (
              <div key={`${t.task}:${t.provider}`} className="flex items-baseline gap-2 text-[13px]">
                <span className="w-40 shrink-0 truncate text-ink">{t.task}</span>
                <span className="w-20 shrink-0 text-ink-muted">{t.provider}</span>
                <span className="w-16 shrink-0 tabular-nums text-ink-muted">{t.calls} calls</span>
                <span className="tabular-nums text-ink">{money(t.usd)}</span>
              </div>
            ))}
          </div>
        </Details>
      )}

      <div className="space-y-4">
        <Row
          title="Text — notes, flashcards, chat, cheat sheets"
          free={textFree}
          freeText={
            textFree
              ? `Local model ready${local.text.models[0] ? ` (${local.text.models[0]})` : ""}`
              : "No local model running"
          }
          help={
            textFree ? null : (
              <>
                Install <a className="font-medium text-accent-deep hover:underline" href="https://ollama.com" target="_blank" rel="noreferrer">Ollama ↗</a>{" "}
                and run <code className="rounded bg-chip px-1 font-mono text-[11px]">ollama pull llama3.1:8b</code>. On this
                machine that's plenty for notes and flashcards, and it costs nothing.
              </>
            )
          }
          value={status.provider}
          onChange={(v) => save({ provider: v }, `Text now: ${PROVIDER_LABEL[v]}.`)}
        />

        <Row
          title="Audio — transcribing lectures"
          free={audioFree}
          freeText={
            audioFree
              ? `Local Whisper ready (${local.audio.engine})`
              : "No local Whisper installed"
          }
          help={
            audioFree ? null : (
              <>
                Run <code className="rounded bg-chip px-1 font-mono text-[11px]">brew install whisper-cpp</code> and put a
                model at <code className="rounded bg-chip px-1 font-mono text-[11px]">models/ggml-large-v3-turbo.bin</code>.
                This is the change that saves the most.
              </>
            )
          }
          value={status.transcribeProvider}
          onChange={(v) => save({ transcribeProvider: v }, `Transcription now: ${PROVIDER_LABEL[v]}.`)}
        />
      </div>

      <div className="mt-5 space-y-3 border-t border-hair pt-4">
        <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={status.cleanTranscripts}
            onChange={(e) => save({ cleanTranscripts: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[#075985]"
          />
          <span>
            Tidy up transcripts into readable prose
            <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-muted">
              Off by default. It rewrites each transcript in full, so you pay for every word twice —
              and search, the assistant, the notes and the flashcards all work fine on the raw text.
              Worth turning on only if you read transcripts directly.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ink">Stop paying past</span>
          <div className="w-28">
            <Input
              density="sm"
              value={budget}
              inputMode="decimal"
              placeholder="no cap"
              onChange={(e) => setBudget(e.target.value)}
              aria-label="Monthly OpenAI budget in dollars"
            />
          </div>
          <span className="text-[13px] text-ink-muted">a month</span>
          <Button
            size="sm"
            disabled={busy === "save"}
            onClick={() => {
              const n = Number(budget);
              save(
                { budgetUsd: budget.trim() === "" ? null : Number.isFinite(n) ? n : undefined },
                budget.trim() === "" ? "Budget cap removed." : `Capped at ${money(n)} a month.`,
              );
            }}
          >
            Save
          </Button>
          {spend.budgetUsd != null && spend.overBudget && (
            <Badge tone="red">reached — paid calls paused</Badge>
          )}
        </div>
      </div>
    </Card>
  );
}

function Row({
  title,
  free,
  freeText,
  help,
  value,
  onChange,
}: {
  title: string;
  free: boolean;
  freeText: string;
  help: React.ReactNode;
  value: string;
  onChange: (v: (typeof PROVIDERS)[number]) => void;
}) {
  return (
    <div className="rounded-field border border-hair p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-ink">{title}</span>
        {free ? <Badge tone="green">{freeText}</Badge> : <Badge tone="amber">{freeText}</Badge>}
      </div>
      {help && <p className="mb-3 text-[12px] leading-relaxed text-ink-muted">{help}</p>}
      <div className="max-w-sm">
        <Segmented
          options={PROVIDERS}
          value={value as (typeof PROVIDERS)[number]}
          onChange={onChange}
          format={(p) => PROVIDER_LABEL[p] ?? p}
        />
      </div>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
        {label}
      </div>
      <div className="mt-0.5 font-display text-[20px] font-bold tabular-nums leading-none text-ink">
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-ink-muted">{hint}</div>}
    </div>
  );
}

/** Sub-cent totals still deserve to be visible rather than rounded to $0.00. */
function money(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
