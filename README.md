# Uni Study

A **local, open-source** study manager that plugs into your university's Moodle/Learn and
Echo360, then does the boring parts for you:

-  **Syncs your Moodle** — active courses, assignments (with briefs), deadlines & opening dates.
-  **Clean calendar + timetable** — imports your university timetable (iCal), colour-codes by
  type, shows a **Today's schedule**, and a click-a-day detail view.
-  **Auto-transcribes lectures** — logs into Echo360, downloads your recordings and transcribes
  them (or grabs existing captions). Also pulls lecture slide decks as text.
-  **AI cheat sheets** — aggregates slides + transcripts + forum posts + briefs into an
  exam-focused cheat sheet per course.
-  **One-click study pack** — every course exported as Markdown to drop into any LLM.
-  **Assignment assistant** — outlines, drafts you rewrite, and feedback. *You stay the author.*
-  **Chat** — quick questions across your courses ("what's due this week?", "where's my next lab?").

Everything runs **on your machine**. Your data, credentials, lecture audio and notes never leave it
except to talk directly to Moodle, Echo360 and OpenAI.

---

## Quick start

**Prerequisites:** [Node.js](https://nodejs.org) ≥ 20 and [ffmpeg](https://ffmpeg.org)
(`brew install ffmpeg` / `apt install ffmpeg`). You'll also want an
[OpenAI API key](https://platform.openai.com/api-keys) — the app will ask for it.

```bash
git clone https://github.com/dylanllove/Moodle_integration.git
cd Moodle_integration
npm install
npx playwright install chromium     # for the Echo360 login/transcription
npm run dev                         # open http://localhost:5173
```

That's it — **no `.env` editing needed.** On first launch the app opens a guided setup at
**http://localhost:5173/setup** that connects Moodle, saves your OpenAI key and imports your
timetable, writing `.env` for you. You can reopen it any time from **Finish setup** in the sidebar.

### What setup asks for

| Step | What it does |
| --- | --- |
| **Moodle** | Sign in with your university username and password and Moodle mints its own access token — the same mechanism the official Moodle app uses. Your password is sent once to your university and never stored. If your uni logs in via Microsoft/Google/Okta, switch to the **Paste a token** tab. |
| **OpenAI key** | Validated against OpenAI before saving. Powers transcripts, notes, cheat sheets and chat. |
| **Timetable** | Paste your timetable's iCal *subscribe* link. It's fetched and imported straight away so you see the class count. A `.ics` file dropped in the project folder is also auto-detected. |
| **Echo360** | Optional. Log in once and new recordings download + transcribe on every launch. |

**If password sign-in doesn't work** (single sign-on, or web services restricted), open
**Preferences → Security keys** in Moodle — or `<your-moodle>/user/managetoken.php` — and copy the
key for the *Moodle mobile web service*. Paste it into the **Paste a token** tab. The setup page also
offers a ready-made prompt for a browser assistant if you can't find that page. If your site has web
services switched off entirely, ask your IT/eLearning team to enable Web Services + the mobile
service; most universities already have it on.

Optional: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for live Google Calendar sync — see `.env.example`.
Setup deliberately skips Google Calendar; nothing depends on it.

---

## How it works (for the curious)

npm-workspace monorepo:

- `apps/web` — React + Vite UI (light, clean)
- `apps/server` — Fastify API
- `packages/db` — local SQLite (via Node's built-in `node:sqlite`)
- `packages/lms` — Moodle Web Services client, Echo360 connector, timetable/iCal ingestion
- `packages/ai` — OpenAI wrappers (summaries, drafting, cheat sheets, chat)
- `packages/transcribe` — ffmpeg + OpenAI transcription

Data lives in `./data/` (SQLite, downloaded audio, transcripts) and is git-ignored.

## Notes & limitations

- **Echo360** has no static API token, so you log in through the browser and **keep the window open**
  during a session (its login can't be persisted across browser restarts).
- **Lecture videos hosted elsewhere** (e.g. SharePoint) can't be pulled automatically — use the
  **Upload recording** button on the Lectures page for those.
- **Attendance:** the app treats lectures as optional/recorded and only flags attendance as required
  when your course's Learn page/announcements say so — it never guesses from the timetable.

## Academic integrity

The assignment assistant helps you think, structure, draft, and get feedback — **you are the author**
and it never submits anything for you. Some assessments prohibit AI use entirely; follow your
institution's rules and cite your sources.

## License

MIT — see [LICENSE](LICENSE).
