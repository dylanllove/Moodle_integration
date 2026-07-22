import type { ReactNode, ButtonHTMLAttributes } from "react";

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
      className={`rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${
        hover ? "transition hover:border-slate-300 hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)]" : ""
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
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[26px] font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost";
  size?: "sm" | "md";
};

export function Button({ variant = "outline", size = "md", className = "", ...props }: BtnProps) {
  const sizing = size === "sm" ? "px-3 py-1.5 text-[13px]" : "px-4 py-2 text-sm";
  const base = `inline-flex items-center justify-center gap-2 rounded-xl font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${sizing}`;
  const styles = {
    primary: "bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 active:bg-indigo-700",
    outline: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
    ghost: "text-slate-600 hover:bg-slate-100",
  }[variant];
  return <button className={`${base} ${styles} ${className}`} {...props} />;
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "red" | "amber" | "green" | "indigo";
}) {
  const tones = {
    neutral: "bg-slate-100 text-slate-600",
    red: "bg-rose-50 text-rose-600 ring-1 ring-inset ring-rose-100",
    amber: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-100",
    green: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-100",
    indigo: "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-100",
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones}`}>
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-500">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
      {label}
    </span>
  );
}

export function EmptyState({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white/50 p-12 text-center">
      <div className="mb-2 text-3xl">{icon}</div>
      <div className="text-sm text-slate-500">{children}</div>
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
