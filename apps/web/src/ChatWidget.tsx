import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Markdown } from "./Markdown.js";
import { Button, Input } from "./ui.js";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "What's due this week?",
  "Explain the key idea from my last MGMT244 lecture",
  "Quiz me on this week's material",
  "What did the lecturer say is important for the exam?",
];

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  // Esc closes — a panel you can't dismiss from the keyboard feels stuck.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function send(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setInput("");
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: "user", content: question }]);
    setBusy(true);
    try {
      const { answer } = await api.ask(question, history);
      setMsgs((m) => [...m, { role: "assistant", content: answer }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", content: `Sorry — ${e}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close study assistant" : "Ask about your courses"}
        aria-expanded={open}
        className="fixed bottom-6 right-6 z-50 flex h-13 w-13 items-center justify-center rounded-pill bg-accent text-ink shadow-lift transition duration-200 hover:brightness-[0.94] active:scale-95"
      >
        {open ? <CloseIcon /> : <ChatIcon />}
      </button>

      {open && (
        <div className="reveal fixed bottom-24 right-6 z-50 flex h-[32rem] w-[24rem] flex-col overflow-hidden rounded-card border border-hair bg-surface shadow-lift">
          <div className="border-b border-hair px-5 py-3.5">
            <div className="font-display text-[15px] font-bold tracking-tight text-ink">
              Study assistant
            </div>
            <div className="text-xs text-ink-muted">Ask about your schedule or your course content</div>
          </div>

          <div className="pane flex-1 space-y-3 px-5 py-4">
            {msgs.length === 0 && (
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                  Try
                </p>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="block w-full rounded-field border border-hair px-3.5 py-2.5 text-left text-[13px] leading-snug text-ink-muted transition duration-200 hover:bg-accent-tint/50 hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                <div
                  className={`max-w-[85%] px-3.5 py-2.5 text-sm ${
                    m.role === "user"
                      ? "rounded-card rounded-br-md bg-accent-tint text-ink"
                      : "rounded-card rounded-bl-md bg-chip text-ink-soft"
                  }`}
                >
                  {m.role === "assistant" ? <Markdown>{m.content}</Markdown> : m.content}
                </div>
              </div>
            ))}
            {busy && <Thinking />}
            <div ref={endRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex gap-2 border-t border-hair p-3"
          >
            <Input
              placeholder="Ask a question…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <Button type="submit" variant="primary" size="sm" disabled={busy || !input.trim()}>
              Ask
            </Button>
          </form>
        </div>
      )}
    </>
  );
}

/** Three dots breathing — calmer than a spinner in a chat log. */
function Thinking() {
  return (
    <div className="flex items-center gap-1.5 px-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-pulse rounded-pill bg-ink-muted/50"
          style={{ animationDelay: `${i * 160}ms`, animationDuration: "1.1s" }}
        />
      ))}
    </div>
  );
}

const stroke = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
function ChatIcon() {
  return (
    <svg className="h-5 w-5" {...stroke} aria-hidden="true">
      <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 9 9 0 0 1-3.6-.7L4 21l1.4-4.1A8.3 8.3 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg className="h-5 w-5" {...stroke} aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
