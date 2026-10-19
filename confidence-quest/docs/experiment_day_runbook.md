# Experiment day runbook

Roles: **Check-in**, **Proctor A**, **Proctor B**, **Tech & data**.
Session size, timing, rooms, devices and eligibility are decision D14 — fill them in here.

## The week before

- [ ] All `[TEAM]` placeholders replaced; `survey.json`, `study.json`, `gamification.json` set to `"status": "approved"`.
- [ ] `npm run check:content` shows **no warnings**.
- [ ] `ALLOCATION_SEED` chosen and written down; set on the host **before the first start**.
- [ ] Pilot with 5-8 classmates in **PILOT** mode (status page → Switch to PILOT mode).
      Review pass rates and timings from the **Pilot exports** buttons (or `npm run export -- --pilot`).
      Pilot rows never appear in the research exports. Switch back to **LIVE** afterwards.
- [ ] Code freeze **48 hours before**. After that only content/config edits, each followed by `npm test`.
- [ ] Full rehearsal on the production host in PILOT mode, then **Delete pilot data** on the status page.

## Before doors open (Tech)

1. Open `https://<host>/healthz` → `{"ok":true}`.
2. Open `https://<host>/admin`, enter the admin token.
   - Mode shows **LIVE**.
   - Live participants: **0** (or the count from earlier sessions).
   - **No yellow warnings.**
3. Press **Back up database now** (or `npm run backup -- before-session-N`). Copy the file off the host.
4. Test every participant device: open the link, see the consent page, **do not** press Start.
5. Print this runbook and the instruction script.

## Check-in

- Explain consent verbally. **No names are written into the app.**
- Give each participant the session link (QR code or short URL).
- Interleave: everyone uses the same link; the app assigns arms. Never assign by seat or friend group.

## Seating and instructions (Proctors)

- Seat participants apart; screens not visible to neighbours.
- Read the same script to everyone (D2). Example:
  > "Please open the link, read the information page and tick the box if you agree.
  > Work on your own. If something goes wrong, raise your hand. You can stop at any
  > time using the link at the bottom of the page."
- Answer **only logistics** questions, with the same words for everyone. Never explain a question.

## During (Tech)

- Watch the status page (it refreshes every 5 s): counts by arm and step, errors in the last hour.
- A participant sees "Connection lost": check `/healthz`; ask them to press **Try again** — nothing they submitted is lost and repeats are ignored.
- A browser closed by mistake: reopen the same link on the **same device and browser**; it resumes at the same step.
- Write every incident in the incident log (time, what happened, participant code if they share it).

## After each session

1. `npm run export` (or download the CSVs from the status page).
2. **Back up database now**; copy the backup and the exports off the host.
3. Record the counts per arm and any incidents.

## Debrief and interviews

- Tell everyone what the two versions were and why (the on-screen debrief says the same).
- Invite 6-8 people from **both** arms to interviews (D18). Ask them to bring their participant code only if they want their interview linked to their answers.

## If someone asks to be removed later

Status page → enter their participant code → **Withdraw a participant's data**. Their
answers are deleted; their allocation slot stays claimed so the sequence is unchanged.
