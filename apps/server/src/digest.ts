import nodemailer from "nodemailer";
import { getDb, getSetting, setSetting } from "@uni/db";
import { courseGrades } from "./grades.js";
import { addDays, computeWorkload, isoDate, mondayOf } from "./workload.js";

/**
 * The Sunday-night digest: one email that answers "what's coming this week?"
 *
 * Built from the same data the app shows, so it can't drift: the week's
 * deadlines, the workload verdict for the week, classes, new lecture notes and
 * course files, and flashcards waiting to be reviewed.
 */

export interface DigestData {
  weekStart: string;
  weekLabel: string;
  deadlines: DigestItem[];
  laterDeadlines: DigestItem[];
  classes: { day: string; count: number; hours: number }[];
  verdict: string;
  hours: number;
  compareLastWeek: number | null;
  newLectures: { title: string; course: string | null }[];
  newMaterials: { title: string; course: string | null; week: number | null }[];
  cardsDue: number;
  atRisk: { course: string; note: string }[];
  overdue: DigestItem[];
}

export interface DigestItem {
  title: string;
  course: string | null;
  kind: string;
  at: string;
  dayLabel: string;
  timeLabel: string;
  weight: number | null;
  url: string | null;
}

/** Build the digest for the week starting on the coming Monday. */
export function buildDigest(reference = new Date()): DigestData {
  const db = getDb();
  // Sunday night looks *forward*: the week that starts tomorrow.
  const weekStart = mondayOf(addDays(reference, 1));
  const weekEnd = addDays(weekStart, 7);
  const fortnightEnd = addDays(weekStart, 14);

  const weights = new Map<string, number>();
  const atRisk: { course: string; note: string }[] = [];
  for (const g of courseGrades()) {
    for (const a of g.assessments) {
      if (a.effectiveWeight > 0) weights.set(norm(a.title), a.effectiveWeight);
    }
    // A course whose target is now out of reach is worth saying out loud early.
    const target = getSetting(`grade_target:${g.course_id}`);
    if (target) {
      const band = g.bands.find((b) => b.letter === target);
      if (band?.impossible) {
        atRisk.push({
          course: g.code || g.name,
          note: `${target} is no longer reachable — best possible is now ${g.ceiling}%.`,
        });
      } else if (band?.neededOnFinal != null && band.neededOnFinal > 85) {
        atRisk.push({
          course: g.code || g.name,
          note: `needs ${band.neededOnFinal}% on ${g.final?.title ?? "the final"} for a ${target}.`,
        });
      }
    }
  }

  /**
   * Only look forward. On a Sunday-night run `reference` is before the week
   * starts, so this is the whole week; run mid-week as a preview it trims the
   * days already gone — which also stops an item appearing under both "overdue"
   * and "due this week".
   */
  const dueFrom = new Date(Math.max(weekStart.getTime(), reference.getTime()));

  const rows = db
    .prepare(
      `SELECT e.title, e.kind, e.start_at, e.url, c.code AS course_code
       FROM events e LEFT JOIN courses c ON c.id = e.course_id
       WHERE e.kind IN ('deadline','exam') AND e.start_at >= ? AND e.start_at < ?
         AND (e.course_id IS NULL OR e.course_id IN (SELECT id FROM courses WHERE active = 1))
       ORDER BY e.start_at`,
    )
    .all(dueFrom.toISOString(), fortnightEnd.toISOString()) as EventRow[];

  const toItem = (e: EventRow): DigestItem => {
    const at = new Date(e.start_at);
    const clean = e.title.replace(/^(Due|Opens):\s*/i, "");
    return {
      title: clean,
      course: e.course_code,
      kind: e.kind,
      at: e.start_at,
      dayLabel: at.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" }),
      timeLabel: at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      weight: weights.get(norm(clean)) ?? null,
      url: e.url,
    };
  };

  const inWeek = (e: EventRow) => new Date(e.start_at) < weekEnd;
  const deadlines = rows.filter(inWeek).map(toItem);
  const laterDeadlines = rows.filter((e) => !inWeek(e)).map(toItem);

  // Anything already past its due date and still on the calendar.
  const overdue = (
    db
      .prepare(
        `SELECT e.title, e.kind, e.start_at, e.url, c.code AS course_code
         FROM events e LEFT JOIN courses c ON c.id = e.course_id
         WHERE e.kind IN ('deadline','exam') AND e.start_at < ? AND e.start_at >= ?
           AND (e.course_id IS NULL OR e.course_id IN (SELECT id FROM courses WHERE active = 1))
         ORDER BY e.start_at DESC`,
      )
      .all(reference.toISOString(), addDays(reference, -10).toISOString()) as EventRow[]
  ).map(toItem);

  const classRows = db
    .prepare(
      `SELECT start_at, end_at FROM events
       WHERE kind = 'class' AND start_at >= ? AND start_at < ?
         AND (course_id IS NULL OR course_id IN (SELECT id FROM courses WHERE active = 1))`,
    )
    .all(weekStart.toISOString(), weekEnd.toISOString()) as { start_at: string; end_at: string | null }[];
  const byDay = new Map<string, { count: number; hours: number }>();
  for (const c of classRows) {
    const d = new Date(c.start_at);
    const key = d.toLocaleDateString([], { weekday: "long" });
    const hours = c.end_at
      ? (new Date(c.end_at).getTime() - d.getTime()) / 3_600_000
      : 1;
    const cur = byDay.get(key) ?? { count: 0, hours: 0 };
    byDay.set(key, { count: cur.count + 1, hours: cur.hours + hours });
  }
  const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const classes = dayOrder
    .filter((d) => byDay.has(d))
    .map((d) => ({ day: d, count: byDay.get(d)!.count, hours: round1(byDay.get(d)!.hours) }));

  // Workload verdict for the coming week, plus how it compares to the one ending.
  const load = computeWorkload(4, 1);
  const thisWeek = load.weeks.find((w) => w.weekStart === isoDate(weekStart));
  const lastWeek = load.weeks.find((w) => w.weekStart === isoDate(addDays(weekStart, -7)));
  const hours = thisWeek?.totalHours ?? 0;
  const compareLastWeek =
    lastWeek && lastWeek.totalHours > 0 ? round1(hours - lastWeek.totalHours) : null;

  const since = addDays(reference, -7).toISOString();
  const newLectures = db
    .prepare(
      `SELECT l.title, c.code AS course FROM lectures l
       LEFT JOIN courses c ON c.id = l.course_id
       JOIN transcripts t ON t.lecture_id = l.id
       WHERE t.status = 'done' AND t.updated_at >= ? ORDER BY t.updated_at DESC LIMIT 12`,
    )
    .all(since) as { title: string; course: string | null }[];

  const newMaterials = db
    .prepare(
      `SELECT m.title, m.week, c.code AS course FROM materials m
       LEFT JOIN courses c ON c.id = m.course_id
       WHERE m.created_at >= ? ORDER BY m.created_at DESC LIMIT 15`,
    )
    .all(since) as { title: string; course: string | null; week: number | null }[];

  const cardsDue = (
    db
      .prepare("SELECT COUNT(*) AS n FROM cards WHERE due_at IS NULL OR due_at <= ?")
      .get(new Date().toISOString()) as { n: number }
  ).n;

  return {
    weekStart: isoDate(weekStart),
    weekLabel: `${weekStart.toLocaleDateString([], { day: "numeric", month: "short" })} – ${addDays(
      weekStart,
      6,
    ).toLocaleDateString([], { day: "numeric", month: "short" })}`,
    deadlines,
    laterDeadlines,
    classes,
    verdict: thisWeek?.verdict ?? "quiet",
    hours,
    compareLastWeek,
    newLectures,
    newMaterials,
    cardsDue,
    atRisk,
    overdue,
  };
}

/* --- Rendering ------------------------------------------------------------ */

const VERDICT_LINE: Record<string, string> = {
  unknown: "No deadlines published for this week yet.",
  quiet: "A quiet week — good one to get ahead.",
  steady: "A steady week. Nothing alarming.",
  busy: "A busy week. Worth planning the order you do things in.",
  heavy: "A heavy week. Start the big one early.",
  brutal: "A brutal week. Something has to give — decide now which thing, deliberately.",
};

export function digestSubject(d: DigestData): string {
  const n = d.deadlines.length;
  const lead = n === 0 ? "Nothing due" : `${n} thing${n > 1 ? "s" : ""} due`;
  return `${lead} this week (${d.weekLabel})`;
}

/** Markdown — what's stored, and what the in-app preview renders. */
export function digestMarkdown(d: DigestData): string {
  const out: string[] = [];
  out.push(`# Your week: ${d.weekLabel}`);
  out.push(`\n**${VERDICT_LINE[d.verdict] ?? ""}** ~${d.hours}h of demand${
    d.compareLastWeek == null
      ? ""
      : d.compareLastWeek > 0
        ? `, ${d.compareLastWeek}h more than last week`
        : `, ${Math.abs(d.compareLastWeek)}h less than last week`
  }.`);

  if (d.overdue.length) {
    out.push(`\n## ⚠️ Overdue\n`);
    for (const i of d.overdue) out.push(`- **${i.title}**${i.course ? ` · ${i.course}` : ""} — was due ${i.dayLabel}`);
  }

  out.push(`\n## Due this week\n`);
  if (!d.deadlines.length) {
    out.push("_Nothing due. Use it._");
  } else {
    for (const i of d.deadlines) {
      const w = i.weight != null ? ` · worth ${i.weight}%` : "";
      out.push(
        `- **${i.dayLabel}, ${i.timeLabel}** — ${i.title}${i.course ? ` (${i.course})` : ""}${w}`,
      );
    }
  }

  if (d.laterDeadlines.length) {
    out.push(`\n## Next week, so you're not surprised\n`);
    for (const i of d.laterDeadlines) {
      out.push(`- ${i.dayLabel} — ${i.title}${i.course ? ` (${i.course})` : ""}`);
    }
  }

  if (d.atRisk.length) {
    out.push(`\n## Grade watch\n`);
    for (const a of d.atRisk) out.push(`- **${a.course}** — ${a.note}`);
  }

  if (d.classes.length) {
    out.push(`\n## Classes\n`);
    for (const c of d.classes) out.push(`- ${c.day}: ${c.count} × (${c.hours}h)`);
  }

  if (d.newLectures.length || d.newMaterials.length) {
    out.push(`\n## New since last week\n`);
    for (const l of d.newLectures) out.push(`- 🎧 ${l.title}${l.course ? ` (${l.course})` : ""} — notes ready`);
    for (const m of d.newMaterials) {
      out.push(`- 📄 ${m.title}${m.course ? ` (${m.course}` : ""}${m.week ? `, week ${m.week})` : m.course ? ")" : ""}`);
    }
  }

  if (d.cardsDue > 0) out.push(`\n## Review\n\n${d.cardsDue} flashcard${d.cardsDue > 1 ? "s" : ""} due.`);

  out.push(`\n---\n_From Uni Study, on your machine._`);
  return out.join("\n");
}

/** Inline-styled HTML — email clients strip stylesheets. */
export function digestHtml(d: DigestData, appUrl: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tone =
    { brutal: "#b3261e", heavy: "#a8641a", busy: "#8f5a16", steady: "#3f6b4a", quiet: "#3f6b4a" }[
      d.verdict
    ] ?? "#3f6b4a";

  const section = (title: string, inner: string) =>
    inner
      ? `<h2 style="font:600 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;text-transform:uppercase;letter-spacing:.1em;color:#6e6e66;margin:26px 0 10px">${title}</h2>${inner}`
      : "";

  const item = (i: DigestItem) => `
    <tr>
      <td style="padding:9px 0;border-bottom:1px solid #eae6e0;font:400 14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#17170f">
        <div style="font-weight:600">${esc(i.title)}</div>
        <div style="color:#6e6e66;font-size:13px;margin-top:2px">
          ${esc(i.dayLabel)}, ${esc(i.timeLabel)}${i.course ? ` · ${esc(i.course)}` : ""}${
            i.weight != null ? ` · worth ${i.weight}%` : ""
          }
        </div>
      </td>
    </tr>`;

  const table = (items: DigestItem[]) =>
    items.length ? `<table width="100%" cellpadding="0" cellspacing="0">${items.map(item).join("")}</table>` : "";

  const list = (rows: string[]) =>
    rows.length
      ? `<ul style="margin:0;padding-left:18px;font:400 14px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#33332b">${rows
          .map((r) => `<li>${r}</li>`)
          .join("")}</ul>`
      : "";

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f7f5f1">
<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #eae6e0;border-radius:14px;padding:28px">
  <div style="font:400 12px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#8f5a16">Uni Study</div>
  <h1 style="font:700 26px/1.2 Georgia,serif;color:#17170f;margin:8px 0 4px">Your week: ${esc(d.weekLabel)}</h1>
  <p style="font:400 15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:${tone};margin:0 0 4px;font-weight:600">
    ${esc(VERDICT_LINE[d.verdict] ?? "")}
  </p>
  <p style="font:400 13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#6e6e66;margin:0">
    About ${d.hours}h of demand${
      d.compareLastWeek == null
        ? ""
        : d.compareLastWeek > 0
          ? ` — ${d.compareLastWeek}h more than the week just gone`
          : ` — ${Math.abs(d.compareLastWeek)}h less than the week just gone`
    }.
  </p>

  ${
    d.overdue.length
      ? `<div style="margin:22px 0 0;padding:12px 14px;background:#fdecea;border-radius:10px;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#8c1d18">
          <strong>Overdue:</strong> ${d.overdue.map((i) => esc(i.title)).join(", ")}
         </div>`
      : ""
  }

  ${section(
    "Due this week",
    d.deadlines.length
      ? table(d.deadlines)
      : `<p style="font:400 14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#6e6e66;margin:0">Nothing due. Use it.</p>`,
  )}
  ${section("Next week, so you're not surprised", table(d.laterDeadlines))}
  ${section(
    "Grade watch",
    list(d.atRisk.map((a) => `<strong>${esc(a.course)}</strong> — ${esc(a.note)}`)),
  )}
  ${section("Classes", list(d.classes.map((c) => `${esc(c.day)}: ${c.count} × (${c.hours}h)`)))}
  ${section(
    "New since last week",
    list([
      ...d.newLectures.map((l) => `🎧 ${esc(l.title)}${l.course ? ` (${esc(l.course)})` : ""} — notes ready`),
      ...d.newMaterials.map(
        (m) => `📄 ${esc(m.title)}${m.course ? ` (${esc(m.course)}${m.week ? `, week ${m.week}` : ""})` : ""}`,
      ),
    ]),
  )}
  ${
    d.cardsDue
      ? section(
          "Review",
          `<p style="font:400 14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#33332b;margin:0">${d.cardsDue} flashcard${
            d.cardsDue > 1 ? "s" : ""
          } due — <a href="${appUrl}/flashcards" style="color:#075985">start a session</a>.</p>`,
        )
      : ""
  }

  <p style="margin:28px 0 0;padding-top:16px;border-top:1px solid #eae6e0;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#8a8a80">
    Sent by Uni Study running on your own machine · <a href="${appUrl}" style="color:#075985">open the app</a>
  </p>
</div>
</body></html>`;
}

/** Plain-text fallback part. */
export function digestText(d: DigestData): string {
  return digestMarkdown(d)
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/_/g, "");
}

/* --- Sending -------------------------------------------------------------- */

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

export function mailConfig(): MailConfig | null {
  const host = process.env.SMTP_HOST ?? "";
  const user = process.env.SMTP_USER ?? "";
  const pass = process.env.SMTP_PASS ?? "";
  const to = getSetting("digest_email") ?? user;
  if (!host || !user || !pass || !to) return null;
  const port = Number(process.env.SMTP_PORT ?? 587);
  return {
    host,
    port,
    // 465 is implicit TLS; 587 upgrades via STARTTLS.
    secure: port === 465,
    user,
    pass,
    from: process.env.SMTP_FROM || user,
    to,
  };
}

export function mailConfigured(): boolean {
  return mailConfig() !== null;
}

export interface SendResult {
  ok: boolean;
  to?: string;
  error?: string;
}

export async function sendDigest(d: DigestData, appUrl: string): Promise<SendResult> {
  const cfg = mailConfig();
  if (!cfg) return { ok: false, error: "Email isn't set up — add SMTP details in Settings." };
  try {
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    await transport.sendMail({
      from: cfg.from,
      to: cfg.to,
      subject: digestSubject(d),
      text: digestText(d),
      html: digestHtml(d, appUrl),
    });
    return { ok: true, to: cfg.to };
  } catch (e) {
    return { ok: false, error: friendlySmtpError(e) };
  }
}

/**
 * SMTP errors are famously opaque, and the two that actually happen are
 * "wrong password" and "Gmail needs an app password".
 */
function friendlySmtpError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/invalid login|username and password not accepted|535/i.test(msg)) {
    return "The mail server rejected those credentials. For Gmail you need an App Password, not your normal password (myaccount.google.com → Security → App passwords).";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return "Couldn't reach that SMTP host — check the server address.";
  }
  if (/ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return "The SMTP server didn't accept the connection — check the port (587 for most, 465 for SSL).";
  }
  return msg;
}

/**
 * Build, store and (if email is configured) send the digest for the coming week.
 * Recorded either way, so the app can show it even with no SMTP set up.
 */
export async function runDigest(
  appUrl: string,
  opts: { force?: boolean } = {},
): Promise<{ weekStart: string; sent: boolean; channel: string; error?: string; markdown: string }> {
  const d = buildDigest();
  const db = getDb();
  const already = db.prepare("SELECT sent_at FROM digests WHERE id = ?").get(d.weekStart) as
    | { sent_at: string | null }
    | undefined;
  if (already?.sent_at && !opts.force) {
    return { weekStart: d.weekStart, sent: false, channel: "skipped", markdown: digestMarkdown(d) };
  }

  const markdown = digestMarkdown(d);
  const result = mailConfigured()
    ? await sendDigest(d, appUrl)
    : { ok: false, error: "no-email" as string | undefined };
  const channel = result.ok ? "email" : "local";

  db.prepare(
    `INSERT INTO digests (id, sent_at, channel, subject, body, error)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET sent_at=excluded.sent_at, channel=excluded.channel,
       subject=excluded.subject, body=excluded.body, error=excluded.error`,
  ).run(
    d.weekStart,
    new Date().toISOString(),
    channel,
    digestSubject(d),
    markdown,
    result.ok ? null : (result.error ?? null),
  );
  setSetting("digest_last_run", new Date().toISOString());

  return {
    weekStart: d.weekStart,
    sent: result.ok,
    channel,
    error: result.ok ? undefined : result.error,
    markdown,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const round1 = (n: number) => Math.round(n * 10) / 10;

type EventRow = {
  title: string;
  kind: string;
  start_at: string;
  url: string | null;
  course_code: string | null;
}
