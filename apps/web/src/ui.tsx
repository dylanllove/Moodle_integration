import { useEffect, useRef, useState } from "react";
import type {
  ReactNode,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
} from "react";

export function Card({
  className = "",
  hover = false,
  children,
}: {
  className?: string;
  hover?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-card border border-hair bg-surface shadow-card ${
        hover ? "transition duration-200 hover:-translate-y-0.5 hover:shadow-lift" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  size = "page",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** "hero" is the oversized dashboard headline; "page" is every other route. */
  size?: "page" | "hero";
}) {
  const heading =
    size === "hero"
      ? "font-display text-[44px] font-black leading-[1.05] tracking-[-0.03em] text-ink sm:text-[56px]"
      : "font-display text-[30px] font-bold leading-tight tracking-[-0.02em] text-ink";
  return (
    <div
      className={`flex flex-wrap items-end justify-between gap-4 ${
        size === "hero" ? "mb-10" : "mb-8"
      }`}
    >
      <div className="max-w-2xl">
        <h1 className={heading}>{title}</h1>
        {subtitle && (
          <p
            className={`text-ink-muted ${
              size === "hero" ? "mt-3 text-base leading-relaxed" : "mt-1.5 text-sm"
            }`}
          >
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "dark";
  size?: "sm" | "md";
};

/** Pills, always. Primary is accent with a near-black label — never white text. */
export function Button({ variant = "outline", size = "md", className = "", ...props }: BtnProps) {
  const sizing = size === "sm" ? "px-3.5 py-1.5 text-[13px]" : "px-5 py-2.5 text-sm";
  const base = `inline-flex items-center justify-center gap-2 rounded-pill font-medium transition duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${sizing}`;
  const styles = {
    primary: "bg-accent text-ink hover:brightness-[0.94] active:brightness-90",
    outline: "border border-hair bg-surface text-ink shadow-card hover:bg-chip",
    ghost: "text-ink-muted hover:bg-chip hover:text-ink",
    dark: "bg-pill text-white hover:bg-ink",
  }[variant];
  return <button className={`${base} ${styles} ${className}`} {...props} />;
}

/**
 * Small, pale-tinted pills. green/amber/red stay semantic — they carry due-date
 * and connection meaning, so they're deliberately outside the accent family.
 * `accent` is for highlighting, not status.
 */
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "red" | "amber" | "green" | "accent";
}) {
  const tones = {
    neutral: "bg-chip text-ink-muted",
    red: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-100",
    amber: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-100",
    green: "bg-[#edf3ec] text-[#3f6b4a] ring-1 ring-inset ring-[#3f6b4a]/15",
    accent: "bg-accent-tint text-accent-deep ring-1 ring-inset ring-accent/50",
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-pill px-2.5 py-0.5 text-xs font-medium ${tones}`}
    >
      {children}
    </span>
  );
}

/**
 * Citation chip — tiny monospace tag for provenance ("Slide 6 · 14:37").
 * Use wherever a piece of content can point at where it came from.
 */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-pill bg-chip px-2 py-0.5 font-mono text-[11px] tracking-tight text-ink-muted">
      {children}
    </span>
  );
}

/** Segmented toggle: the active option is a near-black filled pill. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  format = (o) => String(o),
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  format?: (o: T) => string;
}) {
  return (
    <div className="flex gap-1.5" role="group">
      {options.map((o) => {
        const active = o === value;
        return (
          <button
            key={String(o)}
            onClick={() => onChange(o)}
            aria-pressed={active}
            className={`flex-1 rounded-pill py-1.5 text-xs font-medium transition duration-200 ${
              active
                ? "bg-pill text-white"
                : "border border-hair bg-surface text-ink-muted hover:bg-chip hover:text-ink"
            }`}
          >
            {format(o)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Inline tabs on a pale track. Same dark-pill active language as Segmented,
 * but inline-width — for switching what a panel is showing.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex gap-1 rounded-pill bg-chip p-1" role="tablist">
      {tabs.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={`rounded-pill px-3.5 py-1.5 text-[13px] font-medium transition duration-200 ${
              active ? "bg-pill text-white" : "text-ink-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* --- Form fields ---------------------------------------------------------- */
/* Styling lives in the `.field` base class (see index.css) so utilities passed
   via className always win. Fields fill their container — size them with a
   wrapper, not a width class. */
type Density = { density?: "sm" | "md" };
const field = (d: Density["density"]) => `field${d === "sm" ? " field-sm" : ""}`;

export function Input({
  className = "",
  density,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & Density) {
  return <input className={`${field(density)} ${className}`} {...props} />;
}

export function Textarea({
  className = "",
  density,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & Density) {
  return <textarea className={`${field(density)} resize-y ${className}`} {...props} />;
}

/** Native select with the platform arrow replaced by a quiet chevron. */
export function Select({
  className = "",
  density,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & Density) {
  return (
    <span className="relative flex w-full items-center">
      <select
        className={`${field(density)} cursor-pointer appearance-none pr-9 ${className}`}
        {...props}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-3 h-4 w-4 text-ink-muted"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}

/** Card-level heading in the display serif. */
export function SectionTitle({
  children,
  action,
  className = "",
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 ${className}`}>
      <h2 className="font-display text-[15px] font-bold tracking-tight text-ink">{children}</h2>
      {action}
    </div>
  );
}

/** Inline status message — replaces alert() and one-off tinted cards. */
export function Notice({
  tone = "info",
  children,
  className = "",
}: {
  tone?: "info" | "warn" | "error";
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "bg-accent-tint/50 text-ink ring-accent/30",
    warn: "bg-amber-50 text-amber-900 ring-amber-200/70",
    error: "bg-rose-50 text-rose-800 ring-rose-200/70",
  }[tone];
  return (
    <div
      className={`rounded-card px-4 py-3 text-sm leading-relaxed ring-1 ring-inset ${tones} ${className}`}
      role={tone === "error" ? "alert" : undefined}
    >
      {children}
    </div>
  );
}

/**
 * Collapsed explanation. Setup prose is essential once and noise forever —
 * this keeps it one click away instead of permanently on screen.
 */
export function Details({
  summary,
  children,
  className = "",
}: {
  summary: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`group ${className}`}>
      <summary className="flex cursor-pointer items-center gap-1.5 text-[13px] font-medium text-ink-muted transition duration-200 marker:content-none hover:text-ink">
        <span className="transition duration-200 group-open:rotate-90">
          <svg
            className="h-3 w-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </span>
        {summary}
      </summary>
      <div className="mt-2.5 max-w-2xl pl-[18px] text-[13px] leading-relaxed text-ink-muted">
        {children}
      </div>
    </details>
  );
}

/** Quiet square button for chrome controls (month arrows, close). */
export function IconButton({
  label,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-field text-ink-muted transition duration-200 hover:bg-chip hover:text-ink ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * Window-chrome panel. Traffic-light dots plus a monospace label, framing a
 * card as its own little surface. The label is real, not a faux URL — this
 * sits inside the actual product, so it shouldn't pretend to be a browser.
 */
export function PanelFrame({
  label,
  action,
  className = "",
  children,
}: {
  label: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={`overflow-hidden ${className}`}>
      <div className="flex items-center gap-3 border-b border-hair bg-chip/60 px-4 py-2.5">
        <span className="flex shrink-0 gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-pill bg-ink/15" />
          <span className="h-2.5 w-2.5 rounded-pill bg-ink/15" />
          <span className="h-2.5 w-2.5 rounded-pill bg-ink/15" />
        </span>
        <span className="flex-1 truncate text-center font-mono text-[11px] text-ink-muted">
          {label}
        </span>
        <span className="shrink-0">{action}</span>
      </div>
      {children}
    </Card>
  );
}

/** Fades/rises a section in once, the first time it scrolls into view. */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "-40px 0px -40px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  return (
    <div
      ref={ref}
      className={`${shown ? "reveal" : "opacity-0"} ${className}`}
      style={shown && delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-muted">
      <span className="h-3.5 w-3.5 animate-spin rounded-pill border-2 border-hair border-t-accent-deep" />
      {label}
    </span>
  );
}

/** Centered loading state for a page's initial data fetch. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-24">
      <span className="inline-flex items-center gap-3 text-sm text-ink-muted">
        <span className="h-5 w-5 animate-spin rounded-pill border-2 border-hair border-t-accent-deep" />
        {label}
      </span>
    </div>
  );
}

export function EmptyState({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-hair bg-surface/60 p-12 text-center">
      <div className="mb-2 text-3xl">{icon}</div>
      <div className="text-sm text-ink-muted">{children}</div>
    </div>
  );
}

/** Relative "due in" label + tone for a date. */
export function dueMeta(iso: string | null): {
  label: string;
  tone: "red" | "amber" | "green" | "neutral";
} {
  if (!iso) return { label: "no date", tone: "neutral" };
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { label: "overdue", tone: "red" };
  if (days === 0) return { label: "due today", tone: "red" };
  if (days === 1) return { label: "tomorrow", tone: "amber" };
  if (days <= 7) return { label: `in ${days} days`, tone: "amber" };
  return { label: `in ${days} days`, tone: "green" };
}
