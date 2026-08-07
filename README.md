# Uni Study

A **local, open-source** study manager that plugs into your university's Moodle/Learn and
Echo360, then does the boring parts for you:

-  **Tells you what to do today** — a ranked plan with the reason for each line
  ("due tomorrow · worth 4%", "139 waiting · next assessment in 1 day"), sized in
  minutes. It's arithmetic over your own data, so you can argue with it — and it
  works with the AI switched off entirely.
-  **Syncs your Moodle** — active courses, assignments (with briefs), deadlines & opening dates.
-  **Deadlines everywhere you look** — pushes them to **Google Calendar**, **Notion**, and any
  calendar app (Apple Calendar, Outlook) via a subscribable feed with real alarms.
-  **Clean calendar + timetable** — imports your university timetable (iCal), colour-codes by
  type, and has month, **week-grid** and agenda views plus a **Today's schedule**.
-  **Workload heatmap** — costs every deadline by what it's worth, adds your contact hours *and
  your life outside class*, and shows which weeks are about to get brutal.
-  **Grade calculator** — pulls weightings and marks from the Moodle gradebook and answers
  *"what do I need on the final to get an A?"* — flagging targets that have slipped out of reach.
  Where the gradebook publishes no weightings, it **reads them out of the course outline PDF**
  it already downloaded, rather than asking you to type them in.
-  **Every course file, filed by week** — downloads all slides, readings and handouts into
  `data/materials/<COURSE>/Week 03/…` and extracts the text for study use.
-  **Auto-transcribes lectures** — logs into Echo360 **once**, then keeps the session alive itself.
  Every lecture that can have a transcript gets one: Echo's own captions where they exist, our own
  transcription where they don't, and extracted text for the slide decks Moodle files as lectures.
  Each one then gets study notes and a flashcard deck.
-  **Stays current while it's open** — the whole pipeline re-runs every twenty minutes (and right
  after the laptop wakes), so a day-old app is never what you're looking at.
-  **Flashcards that make themselves** — a deck per lecture, plus decks from any course file, with
  an in-app spaced-repetition reviewer and one-click **Quizlet** / **Anki** export. New cards
  arrive at a daily rate and speed up as a test approaches, so a semester of decks is a habit
  rather than a wall of four hundred.
-  **Sunday-night digest** — one email: what's due, how heavy the week looks, what's new, cards
  waiting, grades at risk.
-  **AI cheat sheets** — aggregates slides + transcripts + forum posts + briefs into an
  exam-focused cheat sheet per course.
-  **One-click study pack** — every course exported as Markdown to drop into any LLM.
-  **Assignment assistant** — outlines, drafts you rewrite, and feedback. *You stay the author.*
-  **One search box (`⌘K`)** — courses, files, lectures, deadlines, decks and notes, plus a
  full-text search *inside* your slides and transcripts. Enter goes straight to the thing.
-  **Chat** — quick questions across your courses ("what's due this week?", "where's my next lab?"),
  streamed as they're written and footnoted with the lecture or slide each answer came from.

-  **Costs what you let it** — every model call goes through one gateway that can run the work on
  your own machine for free (Ollama for text, whisper.cpp for lecture audio), caches answers it has
  already paid for, itemises the spend, and stops at a budget you set.

Everything runs **on your machine**. Your data, credentials, lecture audio and notes never leave it
except to talk directly to Moodle, Echo360, and whichever of OpenAI/Google/Notion/your mail provider
you choose to connect — and with a local model installed, the AI half never leaves it either.

---

## Quick start

**Prerequisites**

- **[Node.js](https://nodejs.org) 24 or newer.** Everything is stored in Node's built-in SQLite,
  which doesn't exist before 23.4 — the app checks on startup and tells you rather than failing
  with a missing-module error.
- **[ffmpeg](https://ffmpeg.org)** — `brew install ffmpeg` / `apt install ffmpeg`.
- **An AI backend**, either of:
  - an [OpenAI API key](https://platform.openai.com/api-keys) — the app asks for it in setup; or
  - nothing at all, if you'd rather run it locally and free (see *Running it for free* below).

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
| **Echo360** | Log in once. The session is kept warm from then on, and new recordings download, transcribe, and turn into notes + a flashcard deck on their own. |
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
| **Notion** | **Two-way, into the databases you already keep.** See below. | An **internal integration** secret from [notion.so/my-integrations](https://www.notion.so/my-integrations), and the pages you shared it with. (A “Connect to Notion” button would need a public OAuth app — overkill for a local tool.) |

### Notion, both ways

Paste the integration secret and the app lists **every page and database Notion says it can
see** — you pick from that list rather than hunting for a URL. Then map each course to a database,
one per paper if that's how you work, with a direction per link.

It writes into **your** tables, not one of its own. The columns are matched by meaning rather than by
name, so a tracker with `Weighting` works and so does one with `Weight`, `Worth` or `%`; the same for
`Raw Score` / `Mark` / `Grade`. If a column plainly isn't there it's left alone rather than guessed
at — nothing gets written into a checkbox called `Excused` just because it was the only checkbox.
When there's nothing to reuse, **Make one** creates a database laid out like the ones you already
have. Study notes arrive as real Notion headings and bulleted lists, not a wall of markdown.

The pull direction is the one that earns its keep: **Moodle often doesn't publish weightings**, and
if you keep them in Notion the grade calculator can just read them. Anything you typed in Notion
wins — pulling updates the app, and pushing never blanks a cell you filled in. Rows the app created
carry a hidden `Uni ID` so a re-sync updates instead of duplicating; rows *you* made have no stamp and
are never archived or overwritten.

### Running it for free

Two things cost money: transcribing lecture audio, and generating text. Both run on your own
machine, and **audio is the one worth doing** — it's about `$0.006`/minute through OpenAI, so a
semester of recordings adds up, while text is cents.

```bash
brew install whisper-cpp     # lecture transcription — the big saving
ollama pull llama3.1:8b      # notes, flashcards, chat  (https://ollama.com)
```

The app finds both on its own. **Settings → AI cost** shows what's been spent and on what, lets you
force either half local, and takes a monthly cap that pauses paid calls when reached. With no OpenAI
key at all it still runs, using whatever is installed locally.

### Flashcards, Quizlet and Anki

Decks are generated from your own transcripts and slides, and reviewed in-app on a Leitner schedule
(intervals 1 → 3 → 7 → 16 → 35 days; a miss drops you two boxes and returns in ten minutes).

A sitting serves **60 cards**, however many are waiting. Every card in a new deck is due
immediately, so a week of auto-generated decks can put two hundred cards "due" at once — and two
hundred cards is not a study session, it's a wall. The backlog is shown honestly ("60 of 202 due");
finishing offers you another sixty rather than sending you back to a list.

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

**On launch, then every twenty minutes**, in the background: personal commitments → Moodle sync →
gradebook → course files → search index → push to Google/Notion → Echo360 recordings → transcripts,
notes and decks for anything still missing them. **Sync everything** in the sidebar runs the same
pipeline on demand and shows which step it's on, so a run that's downloading a semester of slides is
distinguishable from one that's stuck. Steps are independent — an expired Notion token doesn't cost
you your lecture transcripts. The interval is in Settings, and a sync that was due while the machine
slept runs as soon as it wakes.

A few design notes worth knowing:

- **The daily plan is deliberately not a model.** A plan you can't interrogate is one you won't
  trust at 9am, so every line traces to a number — and it keeps working when the AI doesn't.

- **The search index covers your course files, not just transcripts.** Slides and readings are the
  half of a course that's never said out loud; leaving them out made the assistant blind to them.
- **Answers cite what they were built from**, and each citation opens the lecture or slide. An
  ungrounded claim about your own coursework is worse than no answer.

- **Workload is measured in estimated hours**, because hours are what you run out of. A deadline
  costs a share of its weighting; classes and commitments cost their real duration.
- **Weeks are judged against *your* typical week**, not an average student's — 23 hours is a crisis
  for one person and a Tuesday for another.
- **Weeks past the point your courses have published deadlines are labelled "not published yet"**,
  never "quiet". Implying calm you can't actually see would be the worst kind of wrong.

## Notes & limitations

- **Echo360** has no static API token, so you log in through the browser once. Its cookies — including
  the CloudFront signed set that authorises playback — carry no expiry date; they simply go stale if
  the session sits idle, and are reissued on any authenticated request. So the app touches Echo360
  every ten minutes and saves what comes back, which is what turns "log in again each week" into
  "log in once". A login redirect is also no longer taken at face value: a slow single sign-on round
  trip looks identical to an expired session for the first few seconds, so the saved session is only
  given up after it has been refused repeatedly.
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
