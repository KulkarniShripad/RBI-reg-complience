# DSA Self-Check

A mobile-first web app for a psychology study: do engineering students judge their own DSA skill accurately
from platform numbers (solved count, streak, "Beats %"), and does short concept-level feedback ("Strong ·
Next · Tip") make their self-assessment more accurate than numbers alone?

- **About 12 minutes**, 12 short code questions, one tap per answer and per confidence rating.
- **Frontend:** React 19 + TypeScript + Vite, Tailwind CSS 3, highlight.js (Python, C++ and Java only).
- **Data:** Firebase Firestore (free Spark plan) + Anonymous Auth, called straight from the browser; no backend.
- **Hosting:** any static host; Vercel is described below.

Every question, label, feedback template, practice pack and number comes from the five files in
[`src/content/`](src/content). Edit a JSON file, redeploy, and the app changes. No component holds study text.

---

## Contents

1. [Run it locally](#1-run-it-locally)
2. [Firebase setup](#2-firebase-setup)
3. [Deploy to Vercel](#3-deploy-to-vercel)
4. [Before data collection: seed the stats](#4-before-data-collection-seed-the-stats)
5. [Testing: pilot and debug links](#5-testing-pilot-and-debug-links)
6. [Editing the content safely](#6-editing-the-content-safely)
7. [Exporting and analysing the data](#7-exporting-and-analysing-the-data)
8. [Study design](#8-study-design)
9. [Data model](#9-data-model)
10. [Project layout](#10-project-layout)

---

## 1. Run it locally

Requires Node 20.19+ or 22.12+.

```bash
cd dsa-self-check
npm install
npm run dev          # http://localhost:5173
```

Without Firebase env vars, `npm run dev` runs in **local test mode**: everything works, but the data and the
counters live in that browser's localStorage, and an amber "Local test mode" strip is shown. To use your real
Firebase project locally, copy `.env.example` to `.env` and fill it in (section 2).

| Command | What it does |
| --- | --- |
| `npm run dev` | dev server |
| `npm test` | content validation + unit tests (assignment, feedback, derived measures) |
| `npm run verify-questions` | compiles and runs every code question in Python, C++ and Java and checks the answer keys (needs `python3`, `g++`, `javac`) |
| `npm run build` | type-check and build to `dist/` |
| `npm run preview` | serve the built `dist/` |
| `npm run export` | export CSVs (section 7) |
| `npm run analyze` | results summary (section 7) |
| `npm run seed-stats -- --zeros` | create the Beats-% histograms (section 4) |

A production build **without** the Firebase env vars shows a "Firebase is not configured" screen instead of
running, so a misconfigured deploy can never silently collect nothing. Building with `VITE_LOCAL_MODE=1` makes a
browser-only demo build on purpose.

### Firebase emulators (optional)

To test against a real Firestore with the real security rules without touching your project:

```bash
npx firebase-tools emulators:start --only auth,firestore --project demo-dsa
# in another terminal: .env with any values for the 4 VITE_FIREBASE_* vars, plus
#   VITE_FIREBASE_PROJECT_ID=demo-dsa
#   VITE_USE_EMULATOR=1
npm run dev
```

The emulators need Java 11+. The export, analysis and seed scripts also work against them: set
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-dsa` instead of `GOOGLE_APPLICATION_CREDENTIALS`.

---

## 2. Firebase setup

1. **Create the project.** Go to <https://console.firebase.google.com> → *Create a project*. Google Analytics is
   not needed. The free **Spark** plan is enough: one participant costs about 30 writes and 10 reads, far below
   the daily free quota (20,000 writes).
2. **Create the database.** Open *Firestore Database → Create database*. Choose the **Standard** edition, keep the
   database ID **`(default)`**, pick a location near your participants (e.g. `asia-south1` for India; it cannot be
   changed later) and start in **production mode**.
3. **Enable Anonymous Authentication.** Open *Authentication → Get started → Sign-in method*, enable
   **Anonymous** and save. Without this, pressing Start keeps showing "Saving…" and the browser console shows
   `auth/admin-restricted-operation`.
4. **Register a web app.** Open *Project settings (gear) → General → Your apps → Web (`</>`)*. Copy `apiKey`,
   `authDomain`, `projectId` and `appId`. These identify the project; they are not secrets.
5. **Deploy the security rules** from [`firestore.rules`](firestore.rules): paste them in *Firestore Database →
   Rules* and *Publish*, or run `npx firebase-tools deploy --only firestore:rules --project <your-project-id>`.
   Each anonymous user can create, read and update only their own `participants/{uid}` document, never delete
   it; signed-in users can read and write `counters/*` and `stats/*`, which the assignment transactions need.
6. **Put the 4 values in `.env`** (copy `.env.example`), then `npm run dev`. The amber "Local test mode" strip
   must disappear. Press Start with `?pilot=1` and check *Firestore Database → Data*: `participants` appears on
   Start, `counters/pilot_blockOrder` when Question 1 opens, `stats/pilot_S1` or `pilot_S2` after the feedback.

---

## 3. Deploy to Vercel

1. Make sure the code is on the branch Vercel builds (normally `main`).
2. On <https://vercel.com>: *Add New → Project*, import the repo, set **Root Directory** to `dsa-self-check`.
   Vercel detects Vite (`npm run build`, output `dist`).
3. Add the four `VITE_FIREBASE_*` values under *Environment Variables* (Production and Preview) and deploy.
4. Vite bakes env vars in at build time, so **redeploy after changing any of them**.

The app is a single page with no URL routes, so it needs no rewrites. Participants open the root URL.

---

## 4. Before data collection: seed the stats

"Beats %" on the feedback screen is computed from `stats/S1` and `stats/S2` (pilot sessions use
`stats/pilot_S1`/`pilot_S2`): `{ counts: [c0, …, c6] }`, where `cK` is how many earlier participants scored K/6 on
that set in Block 1. A participant sees `round(100 × (participants who scored lower) / (all participants))`, or
`config.beatsPctFallback` (50) while the histogram is empty. The app creates missing documents on its own.

The scripts use the Firebase Admin SDK with a **service account key**: *Project settings → Service accounts →
Generate new private key*, saved as `service-account.json` in this folder (git-ignored; never share it).

```bash
export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
node scripts/seed-stats.mjs --show         # print the four stats documents
node scripts/seed-stats.mjs --zeros        # create any missing ones with zeros
node scripts/seed-stats.mjs --from-pilot   # after piloting: fill stats/S1 and S2 from completed pilot scores
```

`--from-pilot` makes the first real participants compare against the pilot students instead of seeing the
fallback 50%. The script refuses to overwrite documents that already hold counts unless you add `--force`.
**Do not reset the real stats once data collection has started.**

---

## 5. Testing: pilot and debug links

| Link | Effect |
| --- | --- |
| `https://…/` | real participant |
| `https://…/?pilot=1` | `pilot: true`: uses `counters/pilot_*` and `stats/pilot_*`; left out of the export and analysis by default |
| `https://…/?debug=1` | testers: a *debug* button with a step-jump menu and the session's group/order/stratum, and no minimum time on the feedback screen. **Debug sessions are always stored as pilot** (and `debug: true`). |

The debug menu's **Reset session** forgets the anonymous user and the "already done" flag, so the next Start is a
new participant. A step jump fills in any data the target screen needs with random answers. Each browser can take
part once; to test again use the debug reset or a private window.

### What has been tested

- `npm run verify-questions`: all 12 answer keys in all 3 languages (60 compile-and-run checks; for every
  fill-the-blank question each wrong option fails at least one test case, so no question has two right answers).
- `npm test`: content validation (including deliberately broken files) and 40 unit tests covering the pairing
  rules, stratum keys, Beats %, Strong/Next selection, topic rows, per-question feedback, Brier score, Spearman
  alignment, quality flags and the other derived measures.
- End-to-end in Chromium at 360 × 740 (mobile, touch) against the Firestore emulator with the real rules: full
  sessions for both groups with no horizontal page scroll; tab-switch recording; reloads mid-block, during a
  per-question review and on the report; 10 tabs starting Block 1 and reaching the group step at the same moment
  (5/5 block orders, 5/5 groups); `?pilot=1` isolation; the back button; Withdraw; export and analysis.
- Lighthouse (mobile, simulated slow 4G): Performance 99, Accessibility 100, Best Practices 100.

---

## 6. Editing the content safely

| File | Holds |
| --- | --- |
| `questions.json` | the 12 questions (sets `S1`, `S2`, 6 each), code in Python/C++/Java, options, answer keys, `version` |
| `ui-text.json` | every on-screen string, grouped by screen, plus the list of `topics`; `{placeholders}` are filled at runtime |
| `feedback.json` | topic names, ✔/△/✘ symbols, the feedback line templates, and a `skill` + `tip` per topic × question type |
| `packs.json` | practice packs: `easy[topic]` (10) and `medium[topic]` (3) as `{ slug, url }`; titles come from the slug |
| `config.json` | every number and switch (below) and `appVersion` |

**Workflow:** edit → `npm test` → (if you changed code in a question: update its test cases in
`scripts/verify-questions.py` and run `npm run verify-questions`) → commit → redeploy. The same validation runs
when the app starts; a malformed file shows a "Content error" page listing every problem. It checks, among other
things, that every set has `questionsPerBlock` questions with the same number per topic, that **S1 and S2 have the
same topic × type mix** (matched blocks), that every `correct` matches an option id, that every code object and
per-language option has `python`, `cpp` and `java`, that every question's topic and type has a feedback template,
and that every `**bold**` marker is closed.

**Topics are data, not code.** `ui-text.json → topics` lists them (ids + labels); `feedback.json → topics` and
`templates` and `packs.json` must have an entry for each. To add or swap a topic, add it in all four places and
add matching questions to both sets.

**Bold:** wrap words in `**…**` in `ui-text.json` or `feedback.json` to show them in bold. The markers are
removed from stored and exported text.

**Switches and numbers in `config.json`:**

| Key | Default | Effect |
| --- | --- | --- |
| `questionsPerBlock` | `6` | questions per block (must be a multiple of the number of topics) |
| `confidence.levels` | `[25, 50, 75, 100]` | the confidence buttons; labels in `ui-text.json → question.confLevels` |
| `questionFeedbackBlocks` | `[2]` | blocks with right/wrong feedback after every question (`[]` = off) |
| `feedbackMinSeconds` | `6` | minimum time on the Block 1 feedback screen |
| `fastAnswerMs` | `4000` | answers faster than this count as "fast" |
| `quality.maxFastAnswers` / `maxAwayAnswers` | `4` / `3` | more fast answers / tab-switched questions than this flags the participant |
| `stratification.scoreBandLowMax` | `3` | Block 1 score ≤ this is the "low" stratum |
| `gapLabel.overAbove` | `15` | Block 1 gap above this is "over" (stratification) |

**Rules once real data collection has started:** never change a question `id` or move it between sets (add a new
id instead); keep option ids stable (correctness is decided by option id); bump `questions.json → version` when
question content changes and `config.json → appVersion` for anything else (both are stored per participant);
don't reorder `src/lib/steps.ts` (`currentStep` is an index into it).

---

## 7. Exporting and analysing the data

```bash
export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json   # see section 4

node scripts/export.mjs                     # real participants, withdrawn excluded → ./export/*.csv
node scripts/export.mjs --include-withdrawn # keep withdrawn participants
node scripts/export.mjs --pilot             # pilot (and debug) sessions only

node scripts/analyze.mjs                    # results summary → ./export/summary.md
node scripts/analyze.mjs --include-flagged  # keep participants with data-quality flags
node scripts/analyze.mjs --pilot            # summary of the pilot
```

**Export** (UTF-8 CSV with a BOM so Excel shows ✔/△/✘):

| File | Rows | Columns |
| --- | --- | --- |
| `participants.csv` | one per participant | every field, flattened with dot-names: `profile.ownPct`, `derived.confGap1`, `ratingMid.dp`, `endSurvey.serious`, `feedback1.linesShown` … Timestamps are ISO-8601 UTC; lists are `|`-separated. |
| `answers.csv` | one per answer | `uid, group, blockOrder, block, setId, position, qid, topic, type, chosen, correct, confidence, timeMs, langAtAnswer, langSwitches, awayCount, awayMs, feedbackMs, feedbackShown` |
| `feedback.csv` | one per feedback screen | `uid, group, block, blockScore, beatsPct, strongTopic, strongType, workOnTopic, workOnType, tip, timeOnScreenMs` |

**Analysis** (`summary.md`): uses completed, non-withdrawn sessions and, by default, drops participants with a
data-quality flag (said they rushed, many very fast answers, or left the tab on several questions). It reports:

- **Sample:** started, completed, drop-outs, each exclusion reason, n per group, median minutes.
- **RQ1 (is there a gap?):** the Block 1 calibration gap (one-sample t-test against 0), % over/underconfident,
  solved count vs actual accuracy (Spearman), trust in the solved count vs the gap, predicted vs actual score.
- **RQ2 (does concept feedback help?):** Group B vs A on the change from Block 1 to Block 2 in the gap (**main
  outcome**), |gap| and Brier score; topic self-rating ↔ accuracy alignment before vs after feedback; change in
  trust in the solved count; time on the feedback screen; practice-pack choice (Medium pack, own weakest topic);
  what participants used to judge their progress. Welch t-tests with Cohen's d, z-tests for percentages.

Treat these as a first look: pre-register the main test (Δ gap, B vs A) and run the final analysis in your
statistics package from the CSVs.

---

## 8. Study design

### Flow (about 12 minutes)

| # | Screen | Stores |
| --- | --- | --- |
| 0 | Consent, with the honesty request ("answer on your own, no Google or AI, stay on this tab; guessing is fine") | `uid, device, pilot, appVersion…` |
| 1 | About you: year, platform, solved count, streak, % solved on own (4 bands), language | `profile` |
| 2 | Before you start: topic self-ratings (1–7), "my solved count shows how good I really am" (1–7), score prediction (0–6); Continue assigns the block order | `ratingStart, beliefStart, scoreGuessStart, blockOrder` |
| 3 | Block 1: 6 questions in random order, options shuffled, one-tap confidence; no feedback (baseline) | `block1.answers[]` |
| 4 | "How many did you get right?"; Continue assigns the **group** | `block1.scoreGuess, group, stratum` |
| 5 | Feedback: both groups see the numbers; Group B also sees topics, a strength and a next step | `feedback1` |
| 6 | Topic self-ratings again (a prediction for Block 2) | `ratingMid` |
| 7 | Block 2: 6 matched questions; after each answer and its confidence, the same screen shows feedback, then Next | `block2.answers[]` incl. `feedbackShown`, `feedbackMs` |
| 8 | "How many did you get right?" | `block2.scoreGuess` |
| 9 | Last 3 questions: solved-count belief again, what they used to judge progress, seriousness check | `endSurvey` |
| 10 | Practice pack: topic + Easy/Medium (a real behavioural choice); the session counts as **completed** here | `packTopic, packType, status, completedAt` |
| 11 | Report + debrief: guessed vs got vs felt-sure per block, topic breakdown, pack links, withdraw | (`withdrawn`) |
| 12 | Thanks | |

### Why it looks like this

- **Short and low-effort, to keep answers genuine.** Long online studies lose people and get careless answers in
  later parts (satisficing); vendor data shows completion drops for surveys over ~7–8 minutes and fatigue rising
  later on. So: 12 questions (6 per block, 3 topics × 2), easy-to-medium, code ≤ 10 lines, short stems, no
  "find the bug" items (the most effortful), one-tap confidence, and only the survey items the analysis uses.
- **Matched blocks.** S1 and S2 have the same topic × question-type mix (fill-the-blank, trace, choose-the-approach)
  and similar difficulty; which set comes first is counterbalanced.
- **Confidence on a 25–100% scale.** With 4 options a pure guess is right 25% of the time, so "Guess" = 25%; a
  0–100 scale would make honest guessers look underconfident. Four labelled buttons (Guess · 50-50 · Fairly sure ·
  Certain) are faster and easier to use consistently than a slider.
- **Data quality.** An honesty request at the start; tab/app switches are recorded per question (`awayCount`,
  `awayMs`) to catch looking answers up; very fast answers are counted; and a seriousness check at the end
  (Aust et al., 2013), with the report unchanged either way so there is no reason to lie. Each participant gets
  `derived.qualityFlags`.
- **Feedback format.** Both groups get the platform-style numbers (score, Beats %, solved count), which is the
  control condition. Group B adds task-level feedback built only from their own answers, following Hattie &
  Timperley's (2007) "how am I going / where to next": a per-topic breakdown (✔/△/✘ with a dot per question), one
  strength, and one next step with a single concrete tip, kept short (Shute, 2008). There is no generic praise
  ("Keep going!"): feedback that turns attention to the self rather than the task tends to help less (Kluger &
  DeNisi, 1996). Focus words are bold.
- **Insight beyond the main outcome.** The belief "my solved count shows how good I really am" is asked before and
  after; topic ratings before and after the feedback are compared with topic accuracy (rank alignment); the
  practice pack is a real choice (count-friendly Easy vs skill-building Medium, and whether they pick their own
  weakest topic); and one item asks what they actually used to judge their progress.
- **Ethics.** Anonymous; all feedback comes from the participant's real answers; the hypothesis and the groups are
  revealed only in the debrief; withdrawal is one tap.

### Assignment (all in Firestore transactions)

Each transaction re-reads the participant document first; if the value is already assigned it is returned
unchanged, so retries, double taps and reloads can never re-assign.

- **Block order:** `counters/blockOrder` `{ n, last }`. When `n` is even, draw "12" or "21" at random and store it
  in `last`; when `n` is odd, assign the opposite of `last`. Then `n++`. "12" means S1 first.
- **Group** (after Block 1): `counters/group_{year}_{low|high}_{over|notover}` `{ n, last, countA, countB }` with
  the same pairing rule. `low` means `score1 ≤ 3`; `over` means `confGap1 > 15`. 8 strata.
- **Beats %:** one transaction reads `stats/{setId}`, builds the feedback from the counts before this participant,
  increments `counts[score]` and stores the feedback, so a reload shows the identical screen and never counts twice.
- Pilot sessions use the same ids with the `pilot_` prefix.

### Saving and resume

After every screen the change is merge-written to `participants/{uid}`; writes are queued, coalesced and retried
with backoff, and a copy is kept in localStorage. On reload the app signs back in as the same anonymous user and
continues at the same step, question, review, order and language tab; answered questions cannot be redone. The
back button is neutralised and a `beforeunload` warning is shown while a session is in progress. **Withdraw** sets
`withdrawn: true` and `withdrawnAt` and ends the session.

---

## 9. Data model

`participants/{uid}` (uid = anonymous auth uid):

```ts
{
  uid, createdAt, updatedAt, completedAt, withdrawnAt,
  status: "started" | "completed", withdrawn, pilot, debug,
  appVersion, contentVersion,
  device: { userAgent, screenW, screenH, isMobile },
  currentStep, currentStepName, rev, lang, reviewing,
  blockOrder: "12" | "21", group: "A" | "B", stratum,
  profile: { year, platform, solvedCount, streak, ownPct, language },   // ownPct: "0-25" | "25-50" | "50-75" | "75-100"
  ratingStart, ratingMid: { arrays, window, dp },                       // 1-7
  beliefStart, scoreGuessStart,
  block1 / block2: {
    setId, startedAt, endedAt, score, scoreGuess,
    plan: [{ qid, optionOrder }],
    answers: [{ qid, topic, type, position, optionOrder, chosen, correct,
                confidence,            // 25 | 50 | 75 | 100
                timeMs, awayCount, awayMs, langAtAnswer, langSwitches,
                feedbackShown, feedbackMs }]   // last two: Block 2 only
  },
  feedback1: { shownAt, timeOnScreenMs, blockScore, beatsPct, profileLine,
               strong, workOn: { qid, topic, type, text } | null,       // Group B
               tip, topicRow, topicCorrect,                             // Group B
               linesShown },
  endSurvey: { beliefEnd, judgedBy, serious },
  packTopic, packType: "easy" | "medium",
  derived: {
    score1, score2, meanConf1, meanConf2,
    confGap1, confGap2, absGap1, absGap2,        // gap = mean confidence − % correct
    brier1, brier2,                              // mean (confidence − correct)², lower is better
    scoreGap1, scoreGap2, scoreGapStart,         // guessed − actual score
    resolution1, resolution2,                    // mean conf (right) − mean conf (wrong)
    topicAcc1, topicAcc2, topicConf1, topicConf2,
    ratingAlign1, ratingAlign2,                  // Spearman: topic self-rating vs topic accuracy
    confAlign1, confAlign2,                      // Spearman: topic confidence vs topic accuracy
    gapLabel1, beliefChange, packIsWeakest,
    fastAnswers, awayAnswers, awayMs, qualityFlags, languagesUsed
  }
}
```

Block 1 and Block 2 are **time order**; `block1.setId` says which set came first. Other collections:
`counters/*` (assignment) and `stats/*` (Beats %).

---

## 10. Project layout

```
dsa-self-check/
├─ src/
│  ├─ content/            the five JSON files + types.ts + validate.ts (startup validation)
│  ├─ lib/
│  │  ├─ assignment.ts    pairing rules, stratum, Beats %
│  │  ├─ feedback.ts      feedback screen, per-question feedback, topic rows
│  │  ├─ derived.ts       derived measures (gap, Brier, alignment, quality flags)
│  │  ├─ session.ts       write queue, local mirror, resume
│  │  ├─ steps.ts         the step list
│  │  ├─ flow.ts          block plans, debug fill
│  │  └─ store/           Firestore store (transactions) and local test-mode store
│  ├─ components/         UI kit, code block, language tabs, feedback card, debug menu
│  ├─ screens/            Intro, Block, End
│  └─ App.tsx             the step machine
├─ tests/                 vitest unit tests
├─ scripts/export.mjs     CSV export
├─ scripts/analyze.mjs    results summary
├─ scripts/seed-stats.mjs Beats-% histogram seeding
├─ scripts/verify-questions.py  compiles/runs every question in 3 languages
├─ firestore.rules
└─ firebase.json          rules path + emulator ports
```

### References

- Hattie, J., & Timperley, H. (2007). The power of feedback. *Review of Educational Research, 77*(1), 81–112.
- Shute, V. J. (2008). Focus on formative feedback. *Review of Educational Research, 78*(1), 153–189.
- Kluger, A. N., & DeNisi, A. (1996). The effects of feedback interventions on performance. *Psychological Bulletin, 119*(2), 254–284.
- Aust, F., Diedenhofen, B., Ullrich, S., & Musch, J. (2013). Seriousness checks are useful to improve data validity in online research. *Behavior Research Methods, 45*(2), 527–535.
