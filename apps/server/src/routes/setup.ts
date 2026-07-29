import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { getDb, getSetting, setSetting } from "@uni/db";
import { echoConnected, syncTimetable } from "@uni/lms";
import { saveEnv } from "../env-file.js";

/** The web-service shortname every Moodle site enables for its mobile app. */
const MOBILE_SERVICE = "moodle_mobile_app";

const trimSlash = (s: string) => s.trim().replace(/\/+$/, "");

/** Normalise whatever the user pasted into a site origin we can call. */
function normaliseSite(raw: string): string {
  let url = trimSlash(raw);
  if (!url) throw new Error("Enter your Moodle address.");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${raw}" doesn't look like a web address.`);
  }
  // People paste deep links ("…/my/courses.php"); keep only the site root, but
  // preserve a subdirectory install (example.edu/moodle).
  const path = parsed.pathname.replace(/\/(my|course|user|login)(\/.*)?$/i, "");
  return trimSlash(`${parsed.origin}${path}`);
}

interface SiteInfo {
  sitename: string;
  fullname: string;
  username?: string;
}

/** Confirm a token actually works, and report whose account it is. */
async function verifyToken(site: string, token: string): Promise<SiteInfo> {
  const body = new URLSearchParams({
    wstoken: token,
    wsfunction: "core_webservice_get_site_info",
    moodlewsrestformat: "json",
  });
  let json: any;
  try {
    const res = await fetch(`${site}/webservice/rest/server.php`, { method: "POST", body });
    json = await res.json();
  } catch (e) {
    throw new Error(
      `Couldn't reach ${site}. Check the address, and that you're on a network that can see it (some universities require VPN).`,
    );
  }
  if (json?.exception || json?.errorcode) {
    if (json.errorcode === "invalidtoken") {
      throw new Error("Moodle rejected that token. It may have been reset — generate a new one.");
    }
    throw new Error(json.message ?? "Moodle rejected that token.");
  }
  if (!json?.sitename) {
    throw new Error("That address responded, but not like a Moodle site. Double-check the URL.");
  }
  return { sitename: json.sitename, fullname: json.fullname ?? "", username: json.username };
}

/** True when ffmpeg is on PATH — required to transcribe lecture audio. */
function hasFfmpeg(): Promise<boolean> {
  return new Promise((res) => {
    const p = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    p.on("error", () => res(false));
    p.on("close", (code) => res(code === 0));
  });
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the onboarding page needs to show what's done and what's left. */
  app.get("/api/setup/status", async () => {
    const site = process.env.MOODLE_URL ?? "";
    const token = process.env.MOODLE_TOKEN ?? "";
    let moodle: { connected: boolean; url: string; site?: string; user?: string; error?: string } = {
      connected: false,
      url: site,
    };
    if (site && token) {
      try {
        const info = await verifyToken(trimSlash(site), token);
        moodle = { connected: true, url: site, site: info.sitename, user: info.fullname };
      } catch (e) {
        moodle = { connected: false, url: site, error: String(e instanceof Error ? e.message : e) };
      }
    }

    // A timetable can also come from a .ics dropped in the repo root, with no
    // URL set — so report the imported class count, not just the setting.
    const classes = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'timetable'")
        .get() as { n: number }
    ).n;

    return {
      openai: Boolean(process.env.OPENAI_API_KEY),
      moodle,
      timetable: { url: getSetting("timetable_url") ?? "", classes },
      echo360: echoConnected(),
      deps: { node: process.version, ffmpeg: await hasFfmpeg() },
    };
  });

  /**
   * Sign in with university credentials and let Moodle mint the token itself.
   * This is the same endpoint the official Moodle mobile app uses. The password
   * is forwarded once to the user's own Moodle and never stored.
   */
  app.post<{ Body: { url?: string; username?: string; password?: string } }>(
    "/api/setup/moodle/login",
    async (req, reply) => {
      const { username = "", password = "" } = req.body ?? {};
      let site: string;
      try {
        site = normaliseSite(req.body?.url ?? "");
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      if (!username || !password) {
        return reply.code(400).send({ error: "Enter your username and password." });
      }

      let json: any;
      try {
        const res = await fetch(`${site}/login/token.php`, {
          method: "POST",
          body: new URLSearchParams({ username, password, service: MOBILE_SERVICE }),
        });
        json = await res.json();
      } catch {
        return reply.code(502).send({
          error: `Couldn't reach ${site}/login/token.php. Check the address (and VPN, if your university needs one).`,
        });
      }

      if (!json?.token) {
        // Map Moodle's error codes onto advice the student can act on.
        const code = json?.errorcode ?? "";
        if (code === "enablewsdescription") {
          return reply.code(400).send({
            error: "This Moodle has web services turned off, so no app can connect. Ask IT to enable them.",
            fallback: true,
          });
        }
        if (code === "servicenotavailable" || code === "accessexception") {
          return reply.code(400).send({
            error:
              "This Moodle doesn't offer the mobile-app service that password sign-in needs. Use the manual token method instead.",
            fallback: true,
          });
        }
        return reply.code(400).send({
          error:
            json?.error ??
            "Moodle didn't accept that username and password. If your university uses a single sign-on page (Microsoft/Google/Okta), password sign-in won't work here — use the manual token method.",
          fallback: true,
        });
      }

      let info: SiteInfo;
      try {
        info = await verifyToken(site, json.token);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message, fallback: true });
      }

      saveEnv({ MOODLE_URL: site, MOODLE_TOKEN: json.token });
      setSetting("lms_url", site);
      return { ok: true, site: info.sitename, user: info.fullname, url: site };
    },
  );

  /** Manual path: the user pastes a token from Moodle's Security keys page. */
  app.post<{ Body: { url?: string; token?: string } }>(
    "/api/setup/moodle/token",
    async (req, reply) => {
      let site: string;
      try {
        site = normaliseSite(req.body?.url ?? "");
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      const token = (req.body?.token ?? "").trim();
      if (!/^[a-f0-9]{32}$/i.test(token)) {
        return reply.code(400).send({
          error: "A Moodle token is 32 letters/numbers. Copy the whole value, with no spaces.",
        });
      }

      let info: SiteInfo;
      try {
        info = await verifyToken(site, token);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }

      saveEnv({ MOODLE_URL: site, MOODLE_TOKEN: token });
      setSetting("lms_url", site);
      return { ok: true, site: info.sitename, user: info.fullname, url: site };
    },
  );

  /** Validate an OpenAI key with a listing call (costs nothing) and persist it. */
  app.post<{ Body: { key?: string } }>("/api/setup/openai", async (req, reply) => {
    const key = (req.body?.key ?? "").trim();
    if (!key) return reply.code(400).send({ error: "Paste your API key." });
    if (!key.startsWith("sk-")) {
      return reply.code(400).send({ error: "OpenAI keys start with “sk-”." });
    }

    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${key}` },
      });
    } catch {
      return reply.code(502).send({ error: "Couldn't reach OpenAI. Check your internet connection." });
    }
    if (res.status === 401) {
      return reply.code(400).send({ error: "OpenAI rejected that key. Copy it again from platform.openai.com." });
    }
    if (!res.ok) {
      return reply.code(400).send({ error: `OpenAI returned ${res.status}. Try again in a moment.` });
    }

    saveEnv({ OPENAI_API_KEY: key });
    return { ok: true };
  });

  /**
   * Save a timetable iCal URL and import it straight away, so the student sees
   * a real class count instead of having to trust that it worked.
   */
  app.post<{ Body: { url?: string } }>("/api/setup/timetable", async (req, reply) => {
    const url = (req.body?.url ?? "").trim();
    if (!url) return reply.code(400).send({ error: "Paste your timetable's iCal URL." });

    // webcal:// is what "Add to calendar" links usually hand out.
    const fetchable = url.replace(/^webcal:\/\//i, "https://");
    if (!/^https?:\/\//i.test(fetchable)) {
      return reply.code(400).send({ error: "That should be a link starting with https:// or webcal://" });
    }

    let body: string;
    try {
      const res = await fetch(fetchable);
      if (!res.ok) {
        return reply.code(400).send({
          error: `The timetable link returned ${res.status}. Make sure it's the private “subscribe” link, not the login page.`,
        });
      }
      body = await res.text();
    } catch {
      return reply.code(502).send({ error: "Couldn't download that link. Check it opens in your browser." });
    }

    if (!/BEGIN:VCALENDAR/i.test(body)) {
      return reply.code(400).send({
        error:
          "That link returned a web page, not a calendar feed. Look for an “Export”, “Subscribe” or “.ics” link on your timetable site.",
      });
    }

    setSetting("timetable_url", fetchable);
    try {
      const { classes } = await syncTimetable();
      return { ok: true, classes };
    } catch (e) {
      return reply.code(400).send({ error: `Imported the file but couldn't read it: ${e}` });
    }
  });
}
