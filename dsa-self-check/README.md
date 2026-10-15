# DSA Self-Check

A mobile-first web app for a psychology study on whether concept-level feedback ("Strong · Work on · Tip")
helps engineering students judge their own DSA skill more accurately than numbers alone.

- **Frontend:** React 19 + TypeScript + Vite, Tailwind CSS 3, highlight.js (Python, C++ and Java only)
- **Data:** Firebase Firestore (free Spark plan) + Anonymous Auth, called straight from the browser; no backend
- **Hosting:** any static host; Vercel is described below

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
7. [Exporting the data](#7-exporting-the-data)
8. [How the app works](#8-how-the-app-works)
9. [Data model](#9-data-model)
10. [Project layout](#10-project-layout)

---

## 1. Run it locally

Requires Node 20+.

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
| `npm test` | content validation + unit tests for assignment, feedback and derived measures |
| `npm run build` | type-check and build to `dist/` |
| `npm run preview` | serve the built `dist/` |
| `npm run export` | export CSVs (section 7) |
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

The emulators need Java 11+. Export and seed scripts also work against them: set
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-dsa` instead of `GOOGLE_APPLICATION_CREDENTIALS`.

---

## 2. Firebase setup

1. **Create the project.** Go to <https://console.firebase.google.com> → *Add project*. Google Analytics is not needed.
   The free **Spark** plan is enough: one participant costs about 40 writes and 10 reads, far below the daily
   free quota.
2. **Create the database.** Open *Build → Firestore Database → Create database*. Choose *production mode* and a
   location near your participants (e.g. `asia-south1` for India). The location cannot be changed later.
3. **Enable Anonymous Authentication.** Open *Build → Authentication → Get started → Sign-in method*, enable
   **Anonymous** and save. Without this, pressing Start keeps showing "Saving…" and the browser console shows
   `auth/admin-restricted-operation`.
4. **Register a web app.** Open *Project settings (gear) → General → Your apps → Web (`</>`)*. Give it any name;
   Firebase Hosting is not needed. Copy `apiKey`, `authDomain`, `projectId` and `appId` from the config shown.
   These values are not secrets: they identify the project, and access is controlled by the security rules.
5. **Deploy the security rules** from [`firestore.rules`](firestore.rules), using either option:
   - **Console:** *Firestore Database → Rules*, paste the file's contents, then *Publish*.
   - **CLI:**
     ```bash
     npx firebase-tools login
     npx firebase-tools deploy --only firestore:rules --project <your-project-id>
     ```
   The rules let each anonymous user create, read and update only their own `participants/{uid}` document, and
   never delete it. Signed-in users can read and write `counters/*` and `stats/*`, which the assignment
   transactions need.
6. **Authorise your domain.** Open *Authentication → Settings → Authorized domains* and add your Vercel domain
   (e.g. `dsa-self-check.vercel.app`) and any custom domain. `localhost` is already listed.

---

## 3. Deploy to Vercel

1. Push this repository to GitHub, then on <https://vercel.com> choose *Add New → Project* and import it.
2. Set **Root Directory** to `dsa-self-check`. Vercel detects Vite: the build command is `npm run build` and the
   output directory is `dist`.
3. Under *Environment Variables*, add the four values from Firebase step 4, for *Production* and *Preview*:

   | Name | Example |
   | --- | --- |
   | `VITE_FIREBASE_API_KEY` | `AIzaSy…` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | `your-project.firebaseapp.com` |
   | `VITE_FIREBASE_PROJECT_ID` | `your-project` |
   | `VITE_FIREBASE_APP_ID` | `1:1234567890:web:abc123…` |

4. Deploy. Vite bakes env vars in at build time, so **redeploy after changing any of them**.

The app is a single page with no URL routes, so it needs no rewrites. Participants open the root URL.

---

## 4. Before data collection: seed the stats

"Beats %" is computed from `stats/S1` and `stats/S2` (pilot sessions use `stats/pilot_S1` and `stats/pilot_S2`).
Each is `{ counts: [c0, …, c8] }`, where `cK` is how many earlier participants scored K/8 on that set. A
participant sees `round(100 × (participants who scored lower) / (all participants))`, or
`config.beatsPctFallback` (50) while the histogram is empty. Their own score is then added. The app creates
missing documents on its own, so seeding is optional but recommended.

The scripts use the Firebase Admin SDK with a **service account key**. Create one under *Project settings →
Service accounts → Generate new private key* and save it in this folder as `service-account.json`. It is
git-ignored: never commit it or share it.

```bash
export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json

node scripts/seed-stats.mjs --show         # print the four stats documents
node scripts/seed-stats.mjs --zeros        # create any missing ones with zeros
node scripts/seed-stats.mjs --from-pilot   # after piloting: fill stats/S1 and S2 from completed pilot scores
```

Use `--from-pilot` if you want the first real participants to be compared against the pilot students instead of
seeing the fallback 50%. Debug sessions are left out. The script refuses to overwrite documents that already hold
counts unless you add `--force`. **Do not reset the real stats once data collection has started.**

---

## 5. Testing: pilot and debug links

| Link | Effect |
| --- | --- |
| `https://…/` | real participant |
| `https://…/?pilot=1` | `pilot: true`: uses `counters/pilot_*` and `stats/pilot_*`; left out of the export by default |
| `https://…/?debug=1` | testers: a *debug* button with a step-jump menu, the session's group/order/stratum, and no minimum timers on the feedback screens. **Debug sessions are always stored as pilot** (and `debug: true`), so testing never touches the real counters, stats or export. |

The debug menu's **Reset session** forgets the anonymous user and the "already done" flag, so the next Start is a
new participant. A step jump fills in any data the target screen needs with random answers.

Each browser can take part once: after the last screen it stores `dsa_done=1` and shows "You've already taken
part" from then on. To test again in the same browser, use the debug reset or a private window.

### Quality checklist, as tested

- Unit tests (`npm test`): content validation (including deliberately broken files), the pairing rules for block
  order and group, stratum keys, Beats %, Strong/Work-on selection with ties, the topic rows, all derived
  measures, and that the blank marker appears in every language.
- End-to-end in Chromium at 360 × 740 (mobile, touch), against the Firestore emulator with the real rules:
  - full sessions for both groups, with no horizontal page scroll on any screen;
  - same-stratum participants alternating A/B and 12/21;
  - 10 tabs starting Block 1 and then reaching the group step at the same moment, giving exactly 5/5 block orders,
    5/5 groups and unique uids;
  - `?pilot=1` using only the pilot counters and stats;
  - a reload mid-block resuming at the same question with the same group, order and language tab, with no
    duplicate answers;
  - a reload on a feedback screen showing the identical lines without counting the score twice in `stats`;
  - the back button not moving between steps;
  - Withdraw, and the export producing all three CSVs.
- Lighthouse (mobile, simulated slow 4G): Performance 99–100, Accessibility 100, Best Practices 100 (first paint ≈ 1.7 s, no blocking time, no layout shift).

---

## 6. Editing the content safely

All study content lives in `src/content/`:

| File | Holds |
| --- | --- |
| `questions.json` | the 16 questions (sets `S1`, `S2`), code in Python/C++/Java, options, answer keys, `version` |
| `ui-text.json` | every on-screen string, grouped by screen; `{placeholders}` are filled at runtime |
| `feedback.json` | topic names, ✔/△/✘ symbols, encouragements, line templates, Group-B `templates[topic][type]` |
| `packs.json` | practice packs: `easy[topic]` (10) and `medium[topic]` (3) as `{ slug, url }`; titles come from the slug |
| `config.json` | every number: block size, slider, timers, thresholds, pilot prefix, default language, `appVersion`, and two switches (below) |

**Workflow:** edit → `npm test` → commit → Vercel redeploys. The same validation runs when the app starts, and
a malformed file shows a "Content error" page listing every problem instead of starting a session. It checks,
among other things, that:

- every id in `sets` exists, sits in the right set, and each set has `questionsPerBlock` questions with 2 per
  topic and 2 per type;
- every `correct` matches an option id, and option ids are unique;
- every `code` object and every per-language option `text` has `python`, `cpp` and `java`;
- every ui-text key the app uses exists, every `templates[topic][type]` has a `skill` and a `tip`, and every
  pack entry has a `slug` and an `http(s)` URL.

**Rules once real data collection has started:**

- **Never change a question `id`** or move it between sets. Answers are stored by id. To replace a question, add
  a new id and update `sets`.
- **Bump `questions.json → version`** whenever question content changes, and **`config.json → appVersion`** for
  any other change. Every participant stores both (`contentVersion`, `appVersion`), so you can tell versions apart
  in the export.
- Keep option ids stable. Correctness is decided by option id, never by text, and options are shuffled per
  participant (the order is stored as `optionOrder`).
- Text in `ui-text.json` and `feedback.json` can be reworded freely, but keep the `{placeholders}`.
- **Bold:** wrap words in `**…**` in `ui-text.json` or `feedback.json` to show them in bold, e.g.
  `"workOn": "✘ Work on: **{topic}**, **{skill}**"`. The markers are removed from the stored and exported text,
  and validation rejects an unclosed `**`.

**Switches in `config.json`:**

| Key | Default | Effect |
| --- | --- | --- |
| `questionFeedbackBlocks` | `[2]` | Blocks that show feedback after every question (right/wrong, score so far; Group B also the question's Strong or Work on + Tip line). `[]` turns it off, `[1, 2]` uses it in both blocks (in Block 1 the group is not assigned yet, so everyone gets right/wrong only). |
| `showHowItWorks` | `false` | `true` brings back the "8 questions, then a short break, then 8 more" screen before Block 1. When `false`, the statements screen goes straight to the first question. |
- Do not reorder the steps in `src/lib/steps.ts`. `currentStep` is stored as an index into that list.

---

## 7. Exporting the data

```bash
export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json   # see section 4
node scripts/export.mjs                     # real participants, withdrawn excluded
node scripts/export.mjs --include-withdrawn # keep withdrawn participants
node scripts/export.mjs --pilot             # pilot (and debug) sessions only
node scripts/export.mjs --out ./my-folder   # different output folder (default ./export, git-ignored)
```

This needs Node 18+. It writes three UTF-8 CSVs, with a BOM so Excel shows ✔/△/✘ correctly:

| File | Rows | Columns |
| --- | --- | --- |
| `participants.csv` | one per participant | every field, flattened with dot-names: `profile.language`, `derived.confGap1`, `ratingMid.dp`, `feedback1.linesShown` … Timestamps are ISO-8601 UTC; lists are `|`-separated. |
| `answers.csv` | one per answer | `uid, group, blockOrder, block, setId, position, qid, topic, type, chosen, correct, confidence, timeMs, langAtAnswer, langSwitches, feedbackMs, feedbackShown` (the last two only in blocks with per-question feedback) |
| `feedback.csv` | one per feedback screen | `uid, group, block, blockScore, beatsPct, strongTopic, strongType, workOnTopic, workOnType, tip, timeOnScreenMs` |

Participants who dropped out are included with whatever they completed. Filter on `status == completed` for
completers. `attentionPassed` and `derived.fastAnswers` (answers under `config.fastAnswerMs`) are there for
exclusion rules.

---

## 8. How the app works

### Flow

`src/lib/steps.ts` lists the steps. The stored `currentStep` is the index into this list, and `currentStepName`
is the same step by name.

| # | Step | Stores |
| --- | --- | --- |
| 0 | consent: anonymous sign-in and the participant document are created on Start | `uid, device, pilot, appVersion…` |
| 1 | profile | `profile` |
| 2 | rate yourself | `ratingStart` |
| 3 | statements; Continue assigns the block order and opens Question 1 | `statements, rankGuessStart, scoreGuessStart, blockOrder` |
| 4 | how it works: **skipped** unless `config.showHowItWorks` is `true` (then its Begin assigns the block order) | |
| 5 | Block 1: 8 questions in random order, options shuffled | `block1.answers[]` (one write per answer) |
| 6 | block end; Continue assigns the **group** | `block1.scoreGuess/rankGuess, derived, group, stratum` |
| 7 | feedback screen 1 (Continue unlocks after `feedbackMinSeconds`) | `feedback1` |
| 8 | rate yourself again | `ratingMid` |
| 9–10 | Block 2 + block end. After each answer (and its confidence rating) the same screen shows that question's feedback, with the right option marked, then **Next** | `block2.answers[]` incl. `feedbackShown`, `feedbackMs` |
| 11 | feedback screen 2 | `feedback2` |
| 12 | rate again | `ratingEnd` |
| 13 | end ratings (PC, CF, SC, KN1, KN2, AC in random order) | `endItems, endItemsOrder, attentionPassed` |
| 14 | practice pack | `packTopic, packType` |
| 15 | quick questions (M1 Group B only; M2's `groupBOnly` option Group B only) | `close` |
| 16 | report + debrief, Withdraw button | (`withdrawn`) |
| 17 | preference (mock-ups A and B built from the participant's own Block 2) | `preference, status: completed, completedAt` |
| 18 | thanks | |

- **No URL routes.** The back button is neutralised with a dummy history entry, and a `beforeunload` warning is
  active while a session is in progress.
- **Writes:** after every screen the change is merge-written to `participants/{uid}`. Writes are queued,
  coalesced and retried with backoff, so a flaky mobile connection never drops a screen. A copy is kept in
  localStorage (`dsa_uid`, `dsa_step`, `dsa_state`).
- **Resume:** on reload the app signs back in as the same anonymous user, loads the document and continues at
  `currentStep`. Within a block it continues at the first unanswered question, with the same order, options and
  language tab. Answered questions cannot be redone. If the local copy is ahead (a write never arrived), it is
  pushed. Group, block order and feedback always keep the stored value.
- **Withdraw** sets `withdrawn: true` and `withdrawnAt`, shows `report.withdrawn` and ends the session: the report
  stays visible with the pack links, but there is no Continue, no preference question, and `dsa_done` is set.
- **"Saving…"** appears only when a save or transaction takes longer than 300 ms.

### Assignment (all in Firestore transactions)

Each transaction re-reads the participant document first. If the value is already assigned, it is returned
unchanged, so retries, double taps and reloads can never re-assign.

- **Block order** uses `counters/blockOrder` `{ n, last }`. When `n` is even it draws "12" or "21" at random and
  stores it in `last`; when `n` is odd it assigns the opposite of `last`. Then `n++`. "12" means S1 first.
- **Group** (after Block 1) uses `counters/group_{year}_{low|high}_{over|notover}` `{ n, last, countA, countB }`
  with the same pairing rule. `low` means `score1 ≤ stratification.scoreBandLowMax`. `over` means
  `confGap1 > gapLabel.overAbove`, where `confGap1 = meanConf1 − score1/8 × 100`. That gives 8 strata.
- **Beats %:** one transaction reads `stats/{setId}`, builds the feedback from the counts before this participant,
  increments `counts[score]` and stores the feedback on the participant. A reload therefore shows the identical
  screen and never counts twice.
- Pilot sessions use the same document ids with the `config.pilotPrefix` (`pilot_`).

### Feedback (identical numbers for both groups)

- **Both groups:** `Block N done`, then `score / 8 solved · Beats X%`, the profile line (Step 1 solved-count +
  correct so far + streak; the no-streak version when the streak is 0), and a random encouragement.
- **Group B** also sees:
  - **Strong:** a correct question from the topic with the highest accuracy in this block.
  - **Work on:** a wrong question from the topic with the lowest accuracy, with that question's tip.
  - Ties between equally qualifying questions are broken at random. When there is nothing to show, the "none this
    block" line appears instead.
  - The topic row: ✔ = 2 correct, △ = 1, ✘ = 0, per `feedbackTopicRow`.
- Every line shown is stored in `feedbackN` (structured fields plus `linesShown`). The group is never revealed
  before the debrief.
- **Per-question feedback** (blocks in `questionFeedbackBlocks`, Block 2 by default) appears only after the answer
  and its confidence are recorded, so `confidence` is never influenced by it. Everyone sees ✔ Correct / ✘ Not
  quite, the score so far and the right option marked; Group B also sees the Strong line (right) or the Work on +
  Tip lines (wrong) for that question's topic and type. The exact lines are stored on the answer as
  `feedbackShown`, and the reading time as `feedbackMs`. A reload during this feedback shows it again.
- **Bold:** the topic, skill and tip in the Strong / Work on / Tip lines are bold (set in `feedback.json` with `**…**`).

---

## 9. Data model

`participants/{uid}` (uid = anonymous auth uid). The fields marked † go beyond the build spec and help with
resume and analysis.

```ts
{
  uid, createdAt, updatedAt, completedAt, withdrawnAt†,
  status: "started" | "completed", withdrawn, pilot, debug†,
  appVersion, contentVersion,
  device: { userAgent, screenW, screenH, isMobile },
  currentStep, currentStepName†, rev†,       // rev: save counter used to reconcile on resume
  lang†,                                     // code tab currently selected
  reviewing†,                                // qid whose per-question feedback is on screen, else null
  blockOrder: "12" | "21", group: "A" | "B", stratum,
  profile: { year, platform, solvedCount, streak, ownPct, language },
  ratingStart / ratingMid / ratingEnd: { arrays, window, recursion, dp },   // 1-7
  statements: { G1, G2, G3 }, rankGuessStart, scoreGuessStart,
  block1 / block2: {
    setId, startedAt, endedAt, score, scoreGuess, rankGuess,
    plan†: [{ qid, optionOrder }],           // drawn at block start, so a reload shows the same order
    answers: [{ qid, topic, type, position, optionOrder, chosen, correct,
                confidence, timeMs, langAtAnswer, langSwitches,
                feedbackShown†, feedbackMs† }]  // † only in blocks with per-question feedback
  },
  feedback1 / feedback2: {
    shownAt, timeOnScreenMs, blockScore, beatsPct, profileLine, encouragement,
    strong, workOn: { qid, topic, type, text } | null,   // Group B
    tip, topicRow: { arrays, window, recursion, dp } | null, // Group B (symbols)
    linesShown†: string[]
  },
  endItems: { PC, CF, SC, KN1, KN2, AC }, endItemsOrder†, attentionPassed,
  packTopic, packType, close: { M1, M2, O1, O2, O3 }, preference,
  derived: {
    score1, score2, meanConf1, meanConf2, confGap1, confGap2, absGap1, absGap2,
    scoreGap1, scoreGap2, resolution1, resolution2,
    topicAcc1, topicAcc2, topicConf1, topicConf2, gapLabel1, fastAnswers, languagesUsed
  }
}
```

Block 1 and Block 2 are **time order**; `block1.setId` says which question set came first. Derived measures
are rounded to 4 decimals. `resolution` is `null` when a block has no correct or no wrong answers.

Other collections: `counters/*` (assignment, section 8) and `stats/*` (Beats %, section 4).

---

## 10. Project layout

```
dsa-self-check/
├─ src/
│  ├─ content/            the five JSON files + types.ts + validate.ts (startup validation)
│  ├─ lib/
│  │  ├─ assignment.ts    pairing rules, stratum, Beats %
│  │  ├─ feedback.ts      feedback screens, Strong/Work on, topic rows
│  │  ├─ derived.ts       derived measures
│  │  ├─ session.ts       write queue, local mirror, resume
│  │  ├─ steps.ts         the step list
│  │  ├─ flow.ts          block plans, debug fill
│  │  └─ store/           Firestore store (transactions) and local test-mode store
│  ├─ components/         UI kit, code block, language tabs, feedback card, debug menu
│  ├─ screens/            Intro, Block, End
│  └─ App.tsx             the step machine
├─ tests/                 vitest unit tests
├─ scripts/export.mjs     CSV export
├─ scripts/seed-stats.mjs Beats-% histogram seeding
├─ firestore.rules
└─ firebase.json          rules path + emulator ports
```
