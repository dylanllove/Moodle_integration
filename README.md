# Uni Study

A **local, open-source** study manager that plugs into your university's Moodle/Learn and
Echo360, then does the boring parts for you:

-  **Syncs your Moodle** — active courses, assignments (with briefs), deadlines & opening dates.
-  **Deadlines everywhere you look** — pushes them to **Google Calendar**, **Notion**, and any
  calendar app (Apple Calendar, Outlook) via a subscribable feed with real alarms.
-  **Clean calendar + timetable** — imports your university timetable (iCal), colour-codes by
  type, and has month, **week-grid** and agenda views plus a **Today's schedule**.
-  **Workload heatmap** — costs every deadline by what it's worth, adds your contact hours *and
  your life outside class*, and shows which weeks are about to get brutal.
-  **Grade calculator** — pulls weightings and marks from the Moodle gradebook and answers
  *"what do I need on the final to get an A?"* — flagging targets that have slipped out of reach.
-  **Every course file, filed by week** — downloads all slides, readings and handouts into
  `data/materials/<COURSE>/Week 03/…` and extracts the text for study use.
-  **Auto-transcribes lectures** — logs into Echo360, downloads your recordings and transcribes
  them (or grabs existing captions), then writes study notes.
-  **Flashcards that make themselves** — a deck per lecture, plus decks from any course file, with
  an in-app spaced-repetition reviewer and one-click **Quizlet** / **Anki** export.
-  **Sunday-night digest** — one email: what's due, how heavy the week looks, what's new, cards
  waiting, grades at risk.
-  **AI cheat sheets** — aggregates slides + transcripts + forum posts + briefs into an
  exam-focused cheat sheet per course.
-  **One-click study pack** — every course exported as Markdown to drop into any LLM.
-  **Assignment assistant** — outlines, drafts you rewrite, and feedback. *You stay the author.*
-  **Chat** — quick questions across your courses ("what's due this week?", "where's my next lab?").

Everything runs **on your machine**. Your data, credentials, lecture audio and notes never leave it
except to talk directly to Moodle, Echo360, OpenAI and whichever of Google/Notion/your mail provider
you choose to connect.

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

Only the first two are required. The rest are offered in order and can be done whenever.

| Step | What it does |
| --- | --- |
| **Moodle** | Sign in with your university username and password and Moodle mints its own access token — the same mechanism the official Moodle app uses. Your password is sent once to your university and never stored. If your uni logs in via Microsoft/Google/Okta, switch to the **Paste a token** tab. |
| **OpenAI key** | Validated against OpenAI before saving. Powers transcripts, notes, cheat sheets, flashcards and chat. |
| **Timetable** | Paste your timetable's iCal *subscribe* link. It's fetched and imported straight away so you see the class count. A `.ics` file dropped in the project folder is also auto-detected. |
| **Echo360** | Log in once and new recordings download, transcribe, and turn into notes + a flashcard deck on every launch. |
| **Course files** | Downloads every slide deck and reading into week folders and extracts their text. Re-runs each launch, fetching only what's new. |
| **Weightings** | Imports the gradebook so the grade calculator works. If your site doesn't publish weightings, type them in once from the course outline. |
| **Life outside class** | Your weekly commitments — shifts, training, family. Without these the workload heatmap is fiction. |
| **Deadline sync** | Google Calendar, Apple Calendar and/or Notion. See below. |
| **Weekly digest** | SMTP details for the Sunday-night email. Gmail needs an [App Password](https://myaccount.google.com/apppasswords). |

### Sending deadlines out

| Destination | How it works | What you need |
| --- | --- | --- |
| **Google Calendar** | OAuth. Writes to its own *Uni Study* calendar so you can hide it in one click; re-syncs update in place and cancelled items are deleted. | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in `.env` — Google only issues OAuth clients per project, so a self-hosted app can't ship one. |
| **Apple Calendar** *(and Outlook, or Google without OAuth)* | A subscribable `webcal://` feed with per-event alarms at your reminder lead time. Refreshes hourly **even when Uni Study isn't running**. Apple has no write API that doesn't involve storing your Apple ID, so subscription is both the standard route and the more robust one. | Nothing. One click in Settings. |
| **Notion** | Creates a *Uni Study — Deadlines* database with course, type, weighting and status, matched on a hidden id so re-syncs update rather than duplicate. | An **internal integration** secret from [notion.so/my-integrations](https://www.notion.so/my-integrations), and the page you shared it with. (A “Connect to Notion” button would need a public OAuth app — overkill for a local tool.) |

### Flashcards, Quizlet and Anki

Decks are generated from your own transcripts and slides, and reviewed in-app on a Leitner schedule
(intervals 1 → 3 → 7 → 16 → 35 days; a miss drops you two boxes and returns in ten minutes).

**Quizlet retired its public write API in 2021**, so no app can create a set for you — importing is
the supported path. *Copy for Quizlet* puts the deck on your clipboard in Quizlet's default import
format (tab between term and definition, newline between cards); paste it into
**Create a set → Import**. Anki users can download a two-column CSV that maps straight onto the
Basic note type.

**If password sign-in doesn't work** (single sign-on, or web services restricted), open
**Preferences → Security keys** in Moodle — or `<your-moodle>/user/managetoken.php` — and copy the
key for the *Moodle mobile web service*. Paste it into the **Paste a token** tab. The setup page also
offers a ready-made prompt for a browser assistant if you can't find that page. If your site has web
services switched off entirely, ask your IT/eLearning team to enable Web Services + the mobile
service; most universities already have it on.

Every optional key lives in `.env.example`. Nothing depends on any of them.

---

## How it works (for the curious)

npm-workspace monorepo:

- `apps/web` — React + Vite UI (light, clean)
- `apps/server` — Fastify API, plus the grade maths, workload model, digest builder and
  Google/Notion sync
- `packages/db` — local SQLite (via Node's built-in `node:sqlite`)
- `packages/lms` — Moodle Web Services client, Echo360 connector, timetable/iCal ingestion,
  course-file downloader, gradebook import, commitment expansion
- `packages/ai` — OpenAI wrappers (summaries, drafting, cheat sheets, flashcards, chat)
- `packages/transcribe` — ffmpeg + OpenAI transcription

Data lives in `./data/` (SQLite, downloaded audio, transcripts, `materials/`) and is git-ignored.

**On every launch**, in the background: Moodle sync → local search index → gradebook → course files
→ push to Google/Notion → Echo360 recordings (transcribe, write notes, build a deck). Personal
commitments are re-expanded into calendar events so the week view and heatmap are always current.

A few design notes worth knowing:

- **Workload is measured in estimated hours**, because hours are what you run out of. A deadline
  costs a share of its weighting; classes and commitments cost their real duration.
- **Weeks are judged against *your* typical week**, not an average student's — 23 hours is a crisis
  for one person and a Tuesday for another.
- **Weeks past the point your courses have published deadlines are labelled "not published yet"**,
  never "quiet". Implying calm you can't actually see would be the worst kind of wrong.

## Notes & limitations

- **Echo360** has no static API token, so you log in through the browser once; the session is then
  persisted and reused.
- **Lecture videos hosted elsewhere** (e.g. SharePoint) can't be pulled automatically — use the
  **Upload recording** button on the Lectures page for those.
- **Course files behind external links** (publisher sites, Google Drive) can't be downloaded — only
  files actually attached in Moodle.
- **Gradebook weightings** aren't published by every Moodle site. When they're missing the grade
  calculator says so and lets you type them in; it never guesses.
- **Attendance:** the app treats lectures as optional/recorded and only flags attendance as required
  when your course's Learn page/announcements say so — it never guesses from the timetable.
- **The digest scheduler** only runs while the app is running. It checks every ten minutes and
  catches up for up to three days, so a laptop that was shut on Sunday night still gets Monday's
  email — but a machine left off all week won't.

## Academic integrity

The assignment assistant helps you think, structure, draft, and get feedback — **you are the author**
and it never submits anything for you. Some assessments prohibit AI use entirely; follow your
institution's rules and cite your sources.

## License

MIT — see [LICENSE](LICENSE).
