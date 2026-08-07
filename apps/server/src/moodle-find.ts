/**
 * Find someone's Moodle for them.
 *
 * Setup asked for "your Moodle address", which assumes the student has ever
 * looked at it. Most haven't — they reach it from a bookmark or a portal tile,
 * and the hostname is usually something like `learn.` or `akoraka.` that nobody
 * memorises. Being stuck on the very first field is the worst possible place to
 * be stuck.
 *
 * But everyone knows their university email. The domain of that address is a
 * reliable handle on the institution, and universities put Moodle on a small,
 * predictable set of subdomains of it. So: take an email, try the handful of
 * likely hosts at once, and ask each one whether it's Moodle — rather than
 * asking the student to go and find out.
 */

/** Subdomains universities actually use, roughly in order of likelihood. */
const PREFIXES = [
  "learn",
  "moodle",
  "lms",
  "elearning",
  "online",
  "study",
  "courses",
  "vle",
  "teaching",
  "class",
  "my",
];

/** Paths for the "one domain, Moodle in a subdirectory" style of install. */
const PATHS = ["", "/moodle", "/learn"];

export interface FoundSite {
  url: string;
  /** The site's own name, read off its login page. */
  name: string | null;
  /** Web services + REST are on — which is what this app actually needs. */
  webServices: boolean;
  /** Why it might not work, in the student's terms. */
  note: string | null;
}

export interface FindResult {
  query: string;
  domain: string | null;
  sites: FoundSite[];
  /** Set when we can't even start — a name with no domain in it, say. */
  advice: string | null;
}

/** Pull the institution's domain out of an email, a URL, or a bare domain. */
export function domainFrom(raw: string): string | null {
  const input = (raw ?? "").trim().toLowerCase();
  if (!input) return null;

  const email = input.match(/[^\s@]+@([a-z0-9.-]+\.[a-z]{2,})/);
  if (email) return stripPublicPrefix(email[1]!);

  const withScheme = /^https?:\/\//.test(input) ? input : `https://${input}`;
  try {
    const host = new URL(withScheme).hostname;
    if (!host.includes(".")) return null;
    return stripPublicPrefix(host);
  } catch {
    return null;
  }
}

/**
 * `student.canterbury.ac.nz` and `canterbury.ac.nz` should both lead to the same
 * candidates, so a student-mail subdomain is dropped — but only where what's left
 * is still a real domain, not a public suffix like `ac.nz`.
 */
function stripPublicPrefix(host: string): string {
  const parts = host.split(".");
  const STUDENTY = /^(student|students|stu|mail|email|alumni|www|my)$/;
  if (parts.length > 2 && STUDENTY.test(parts[0]!)) parts.shift();
  return parts.join(".");
}

function candidates(domain: string): string[] {
  const out: string[] = [];
  for (const prefix of PREFIXES) out.push(`https://${prefix}.${domain}`);
  for (const path of PATHS) if (path) out.push(`https://${domain}${path}`);
  return out;
}

/**
 * Ask a host whether it's Moodle.
 *
 * The REST entry point is the ideal question because it answers two things at
 * once: a Moodle-shaped error proves it's Moodle, and *which* error says whether
 * web services are switched on — which is the thing that actually decides whether
 * this app can work, and the thing students otherwise discover several steps later.
 */
async function probe(base: string, timeoutMs: number): Promise<FoundSite | null> {
  const url = `${base}/webservice/rest/server.php?moodlewsrestformat=json&wsfunction=core_webservice_get_site_info`;
  let body: string;
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    body = (await res.text()).slice(0, 2000);
  } catch {
    return null; // No such host, or it didn't answer in time.
  }

  let parsed: { exception?: string; errorcode?: string } | null = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }

  const looksMoodle =
    parsed?.exception === "moodle_exception" ||
    /moodle/i.test(res.headers.get("set-cookie") ?? "") ||
    /invalidtoken|servicenotavailable|enablewsdescription/i.test(body);
  if (!looksMoodle) return null;

  // "Invalid token" means it wanted a token — i.e. the service is live.
  const code = parsed?.errorcode ?? "";
  const webServices = /invalidtoken|accessexception|tokennotfound/i.test(code) || /invalidtoken/i.test(body);

  return {
    // Follow redirects: some sites answer on a different host than they're asked on.
    url: siteRootOf(res.url, base),
    name: null,
    webServices,
    note: webServices
      ? null
      : "This is Moodle, but web services look switched off — ask your IT or eLearning team to enable Web Services and the Moodle mobile service.",
  };
}

/** Strip the web-service path back to the site root, keeping any subdirectory. */
function siteRootOf(finalUrl: string, fallback: string): string {
  try {
    const u = new URL(finalUrl);
    return `${u.origin}${u.pathname.replace(/\/webservice\/.*$/, "")}`.replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

/** The site's own name, so the student recognises it before committing. */
async function siteName(base: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(`${base}/login/index.php`, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const html = (await res.text()).slice(0, 20_000);
    const title = html.match(/<title[^>]*>([^<]{3,160})<\/title>/i)?.[1];
    if (!title) return null;
    // Titles read "Site name: Log in to the site", but plenty of sites redirect
    // to single sign-on and serve "Sign in to your account" — which names the
    // identity provider, not the university, and would be worse than no name.
    const GENERIC =
      /^(log ?in|sign ?in|logon|authentication|welcome|home|redirecting|loading|sso|single sign)/i;
    const segment = title
      .replace(/&amp;/g, "&")
      .split(/[:|–—]/)
      .map((part) => part.trim())
      .find((part) => part.length >= 3 && !GENERIC.test(part));
    return segment ? segment.slice(0, 80) : null;
  } catch {
    return null;
  }
}

const PROBE_TIMEOUT_MS = 4000;

/**
 * Domains worth trying, not just the one in the email.
 *
 * Universities routinely mail from one domain and teach on another —
 * `myport.ac.uk` for people, `port.ac.uk` for Moodle — so a single guess misses
 * institutions that are otherwise a perfect match.
 */
function domainVariants(domain: string): string[] {
  const out = [domain];
  const parts = domain.split(".");
  const first = parts[0] ?? "";
  // "myport.ac.uk" → "port.ac.uk"
  if (/^my[a-z]{3,}$/.test(first)) out.push([first.slice(2), ...parts.slice(1)].join("."));
  // "student-mail.x.ac.uk" → "x.ac.uk"
  if (parts.length > 2) out.push(parts.slice(1).join("."));
  return [...new Set(out)];
}

export async function findMoodle(query: string): Promise<FindResult> {
  const domain = domainFrom(query);
  if (!domain) {
    return {
      query,
      domain: null,
      sites: [],
      advice:
        "Type your university email address (like you@student.your-uni.ac.nz) — that's enough to find it.",
    };
  }

  // All candidates at once: a dozen sequential four-second timeouts would be a
  // minute of staring at a spinner.
  const bases = domainVariants(domain).flatMap(candidates);
  const results = await Promise.all(
    bases.map((base) => probe(base, PROBE_TIMEOUT_MS).catch(() => null)),
  );

  const seen = new Set<string>();
  const sites: FoundSite[] = [];
  for (const site of results) {
    if (!site || seen.has(site.url)) continue;
    seen.add(site.url);
    sites.push(site);
  }

  // A working site outranks one whose web services are off.
  sites.sort((a, b) => Number(b.webServices) - Number(a.webServices));
  const top = sites.slice(0, 4);
  await Promise.all(
    top.map(async (site) => {
      site.name = await siteName(site.url, PROBE_TIMEOUT_MS);
    }),
  );

  return {
    query,
    domain,
    sites: top,
    advice: top.length
      ? null
      : `Nothing Moodle-shaped answered on ${domain}. If your university uses a different domain for teaching, paste the address of a page you'd normally log in to — any page will do.`,
  };
}
