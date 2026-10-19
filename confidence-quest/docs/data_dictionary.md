# Data dictionary

All exports are UTF-8, comma-separated, one header row. Timestamps are ISO 8601 UTC
(`2026-10-19T09:14:03.512Z`). Missing values are blank. **Pilot rows are excluded from
every file.** No file contains names, emails, student IDs, IP addresses or device data.

Planned analysis (ANCOVA): `post_conf_mean ~ arm_code + pre_conf_mean`, using
`participants.csv` filtered to `status == completed`. See `scripts/analysis/`.

## participants.csv — one row per participant

| Column | Meaning |
|---|---|
| participant_code | Random 6-character code shown on the debrief. The only identifier. |
| arm | `control` or `experimental`; blank if they stopped before the pre-survey was submitted |
| arm_code | 0 = control, 1 = experimental |
| status | `completed`, `in_progress` (never finished, did not press stop), `abandoned` (pressed "Stop taking part"), `withdrawn` (asked afterwards for their data to be removed; all their answers are deleted) |
| last_step | Step they were on last (`PRE_SURVEY`, `INSTRUCTIONS`, `QUESTION`, `FEEDBACK`, `FINAL`, `POST_SURVEY`, `DEBRIEF`) |
| started_at_utc | When they gave consent |
| completed_at_utc | When they submitted the post-survey |
| duration_s | completed_at − started_at, in seconds |
| questions_answered | Questions with an answer (A-D or IDK); expired questions do not count |
| score_raw | Correct answers out of 9. Blank until all nine questions are closed. |
| pre_conf_mean | Mean of the confidence items before the questions, after reverse-coding |
| post_conf_mean | The same items after the questions |
| conf_change | post_conf_mean − pre_conf_mean |
| postdiction | *(only if switched on)* "How many of the nine do you think you got right?" (0-9) |
| calibration_gap | *(only if postdiction is on)* postdiction − score_raw. Positive = overestimated. |
| *measure*_pre / *measure*_post | *(only for extra measures switched on in survey.json)* mean of that measure's items, e.g. `enjoyment_post` |
| tokens_total | Experimental only: tokens earned, recomputed from stored answers with the gamification rules |
| badges_earned | Experimental only: number of badges earned |
| rank_shown | Experimental only: the rank shown the first time the final screen opened |
| rank_pool_size | Experimental only: how many people were on the leaderboard at that moment |
| consent_version | Version string of the consent text they agreed to |

Reverse-coding: a reverse item's value v on a scale min..max is scored as min + max − v
(1-7 scale: 2 → 6).

## questions_long.csv — one row per participant × question shown

| Column | Meaning |
|---|---|
| participant_code, arm | As above |
| question_id | Q1-Q9 |
| section | Sliding Window / Two Pointers / Arrays |
| selected_option | A, B, C, D, IDK ("I don't know", if switched on), or blank (expired / never answered) |
| is_correct | 1 or 0 (blank if never answered and not expired) |
| time_taken_ms | answered_at − shown_at. shown_at is the **first** time the question was served, so a refresh does not reset it. |
| answered_at_utc | When the answer was submitted |
| position | Order in which it was shown (1-9) |
| difficulty_label | Easy / Medium / Hard (provisional labels) |
| response_status | `answered`, `expired` (closed by the time limit), `not_answered` (shown, then the participant stopped) |
| shown_at_utc | First time the question was served. For questions closed by the time limit before being shown, this is the expiry time. |

## surveys_long.csv — one row per participant × survey item

| Column | Meaning |
|---|---|
| participant_code, arm | As above |
| phase | `pre` or `post` |
| item_id | Item id from survey.json |
| value | Raw value the participant chose |
| measure | `confidence`, `postdiction`, `manipulation_check`, ... |
| reverse | 1 if the item is reverse-coded |
| value_scored | value after reverse-coding (what the means use) |

## events.csv — append-only audit log

`participant_code` (blank for system events), `event_type`, `payload` (JSON), `created_at_utc`.
Event types: `consent_given`, `survey_submitted`, `arm_assigned`, `instructions_ack`,
`question_shown`, `answer_submitted`, `feedback_ack`, `results_viewed`, `results_ack`,
`completed`, `withdrawn` (pressed stop), `time_expired`, `error` (code + route only, never
participant text), `content_changed`, `backup_taken`, `study_mode_changed`,
`allocation_extended`, `pilot_data_purged`, `data_withdrawn`.

## gamification_events.csv — experimental arm only

`participant_code`, `type`, `key`, `value`, `created_at_utc`.
`tokens` (key = question id, value = tokens earned), `badge` (key = badge key),
`leaderboard_view` (key `rank` / `pool_size`: what was shown each time the final screen opened).

## allocation.csv — the full allocation list

`seed`, `block_size`, `list` (`main` / `pilot`), `seq_no`, `block_no`, `arm`, `claimed` (0/1),
`participant_code` (blank for unclaimed and pilot slots), `claimed_at_utc`. The list can be
regenerated exactly from the seed: `npm run allocation -- --preview --seed <seed>`.
Slots of participants who stopped are never reused.

## meta.csv

Schema version, allocation seed and block size, study mode, the SHA-256 of every content
file used, the questions version, and the export time.
