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

**Prerequisites:** [Node.js](https://nodejs.org) ≥ 20, [ffmpeg](https://ffmpeg.org)
(`brew install ffmpeg` / `apt install ffmpeg`), a Moodle **Web Services token**, and an
**OpenAI API key**.

```bash
git clone https://github.com/dylanllove/Moodle_integration.git
cd Moodle_integration
npm install
npx playwright install chromium     # for the Echo360 login/transcription
cp .env.example .env                # then edit .env (see below)
npm run dev                         # open http://localhost:5173
```

### Fill in `.env`

```ini
MOODLE_URL=https://learn.your-uni.ac.nz
MOODLE_TOKEN=your-moodle-webservices-token
OPENAI_API_KEY=sk-...
```

**Getting your Moodle token:** in Moodle go to **Preferences → Security keys**, and copy the token
for the *Moodle mobile web service* (if it's not enabled, ask your IT/eLearning team to turn on
Web Services + the mobile service — most unis have it on).

Optional: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for live Google Calendar sync — see `.env.example`.

### First run

1. Open **http://localhost:5173** → it syncs Moodle automatically.
2. **Settings → Class timetable** — paste your uni timetable's iCal/"subscribe" URL, *or* drop the
   `.ics` file into the project folder (it's auto-detected).
3. **Settings → Echo360** — click **Connect Echo360**, log in, and keep that window open.
   Transcription of your lectures starts automatically.
4. **Courses → ✨ Cheat sheet**, or **Download study pack**, whenever you want.

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
