# Decision register: what the app does today, and where to change it

Every open decision is a **content or config edit, never a code change**. The app ships
with a working default for each one so it runs end to end; defaults that are only
placeholders show up as warnings on server start and on the admin status page.

| # | Decision | Built-in default (what runs now) | Where to change it |
|---|---|---|---|
| D1 | Consent text, debrief, how to withdraw | Placeholder text marked `[TEAM: …]`; consent version `consent-PLACEHOLDER-v0` | `study.json` → `consent`, `debrief`, `withdraw`. **Bump `consent.version`** whenever the wording changes (it is stored with every participant). |
| D2 | Instructions text (same for both arms) | Four neutral paragraphs | `study.json` → `instructions` |
| D3 | "I don't know" option | Off | `study.json` → `questions.dont_know_option.enabled`. Stored as `IDK`, always scored incorrect. |
| D4 | Tokens | On: correct answers earn Easy 1 / Medium 2 / Hard 3 (design-review candidate) | `gamification.json` → `tokens` (`enabled`, `award_on`: `correct` or `any_answer`, `points_by_difficulty`) |
| D4 | Extra instructions line for the experimental arm | On: one sentence explaining tokens, badge, leaderboard | `gamification.json` → `instructions_extra` (empty string = no extra line) |
| D5 | Badges | One effort badge, "Finisher", for answering all nine | `gamification.json` → `badges.definitions`. Rule types: `answered_count`, `correct_count`, `correct_streak`, `section_all_correct`. |
| D6 | Leaderboard: who, names, size, ties, refresh | Top 5 + the participant's own row; random pseudonyms ("Swift Otter"); ranked by tokens; ties → earlier finish; computed live when the final screen opens; only real experimental participants who finished the nine questions | `gamification.json` → `leaderboard` (`enabled`, `metric`, `top_n`, `include_self_row`, `tie_break`: `earlier_finish` / `less_total_time` / `shared`, `names`, `include_pilot_results`) |
| D7 | Rank / percentile | Both: "You are ranked 3 of 12." + "That puts you in the top 25%." | `gamification.json` → `rank.show`: `none` / `rank` / `percentile` / `both`, plus the two text templates |
| D8 | Control final screen | Shows "You answered X of 9 questions correctly." (the same line the experimental arm sees) | `study.json` → `final_screen.control.show_score` / `paragraphs` |
| D9 | Survey items, scale, reverse coding | **Placeholders**: 5 confidence items on a 1-7 scale, one reverse-coded (`conf_4`). Extra measures (postdiction, manipulation check, pressure, enjoyment, prior experience, competitiveness) exist but are switched off. | `survey.json`. Set `"status": "approved"` once the team's wording is in. Turning on an extra measure adds its column to `participants.csv` automatically. |
| D10 | Time limit and what happens at expiry | Off. When on: one total limit from "Start question 1"; at expiry every unanswered question is stored as expired (no answer, incorrect) and the participant goes to the final screen. A countdown shows in the top bar. | `study.json` → `questions.time_limit` (`enabled`, `total_seconds`) |
| D11 | Q5 context; showing Easy/Medium/Hard labels | Q5 shown verbatim with no extra context; labels hidden from participants (still used for tokens) | Add a `note` field to Q5 in `questions.json` (shown under the code) — this changes the verbatim content, so also update Appendix A. Labels: `study.json` → `questions.show_difficulty_labels`. |
| D12 | Question order | Fixed Q1 → Q9 for everyone | `study.json` → `questions.order`: `fixed` or `random_per_participant` (each participant's order is stored) |
| D13 | Allocation: block size, slot count, pilot list | Block size **2**, 60 main slots, separate 20-slot pilot list; extends by whole blocks if it ever runs out | `study.json` → `allocation`; seed via `ALLOCATION_SEED`. Locked into the database at first start. |
| D14 | Session size, timing, rooms, devices, eligibility | Not an app setting | `docs/experiment_day_runbook.md` |
| D15 | Hosting; no IP logging on the host | App never logs IPs/user agents. Host choice open (Render / Railway / Fly.io or the laptop fallback) | README → Deploy. Turn off or shorten request logs on the host. |
| D17 | Weighted points for the leaderboard | Leaderboard ranks by tokens (= weighted points 1/2/3); `score_raw` (out of 9) is always recorded separately | `gamification.json` → `leaderboard.metric`: `tokens` or `score_raw` |
| D18 | Linking interviews | Only through the participant code the participant chooses to share; the app stores nothing else | Debrief text in `study.json` |

## Why block size 2 (D13)

The acceptance test says 50 participants must always split within 1 of each other.
With blocks of 4, a run that stops two places into a block can be 2 apart (for example
`EE` from an `EECC` block). Blocks of 2 guarantee the AC for any number of
participants. Predictability is not a concern here because nobody chooses their own
arm and the browser never sees it. If the team prefers 4, change `block_size` before the
first start; `npm run allocation -- --simulate 1000 --n 50 --block-size 4` shows the
worst-case difference (2).

## Content issues flagged (not fixed silently)

- **Q5** depends on a standard 3Sum loop that is not on screen (D11).
- **Q6** shows the comment `# bug` in the code, which points participants at the faulty line. Kept verbatim.
- **Q9** has no prompt sentence, only the code. Kept verbatim; consider adding "What does this print?".
- Easy/Medium/Hard labels are provisional until the pilot (D11).

The answer key was checked by hand against every code snippet: Q1 D, Q2 C (7 subarrays),
Q3 A, Q4 B, Q5 D (no duplicate skipping gives two identical triplets), Q6 A (`[1, 0, 2]`:
the bug skips re-checking the swapped-in 0), Q7 B, Q8 C, Q9 D (Boyer-Moore ends on 2).
