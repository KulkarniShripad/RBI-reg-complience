-- Confidence Quest schema. Applied on every start by server/db/migrate.js (idempotent).
-- All timestamps are ISO 8601 UTC strings. No names, emails, IPs or device identifiers.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id                    TEXT PRIMARY KEY,                 -- uuid
  participant_code      TEXT NOT NULL UNIQUE,             -- 6 readable characters, shown on the debrief
  token_hash            TEXT NOT NULL UNIQUE,             -- sha256 of the session cookie; the token itself is never stored
  is_pilot              INTEGER NOT NULL DEFAULT 0 CHECK (is_pilot IN (0, 1)),
  consent_at            TEXT NOT NULL,
  consent_version       TEXT NOT NULL,
  arm                   TEXT CHECK (arm IN ('control', 'experimental')),   -- null until the pre-survey is submitted
  allocation_slot_id    INTEGER REFERENCES allocation_slots(id),
  current_step          TEXT NOT NULL,
  current_question      INTEGER,                          -- position 1..9 while in QUESTION/FEEDBACK
  question_order        TEXT,                             -- JSON array of question ids, fixed at assignment
  leaderboard_name      TEXT UNIQUE,                      -- pseudonym, experimental arm only
  started_at            TEXT NOT NULL,
  assigned_at           TEXT,
  questions_started_at  TEXT,
  questions_finished_at TEXT,
  completed_at          TEXT,
  abandoned_at          TEXT,
  status                TEXT NOT NULL DEFAULT 'in_progress'
                        CHECK (status IN ('in_progress', 'completed', 'abandoned', 'withdrawn'))
);

CREATE TABLE IF NOT EXISTS allocation_slots (
  id         INTEGER PRIMARY KEY,
  list       TEXT NOT NULL CHECK (list IN ('main', 'pilot')),
  seq_no     INTEGER NOT NULL,
  block_no   INTEGER NOT NULL,
  arm        TEXT NOT NULL CHECK (arm IN ('control', 'experimental')),
  claimed_by TEXT UNIQUE REFERENCES participants(id),
  claimed_at TEXT,
  UNIQUE (list, seq_no)
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id             INTEGER PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  phase          TEXT NOT NULL CHECK (phase IN ('pre', 'post')),
  item_id        TEXT NOT NULL,
  value          INTEGER NOT NULL,
  submitted_at   TEXT NOT NULL,
  UNIQUE (participant_id, phase, item_id)
);

CREATE TABLE IF NOT EXISTS question_responses (
  id              INTEGER PRIMARY KEY,
  participant_id  TEXT NOT NULL REFERENCES participants(id),
  question_id     TEXT NOT NULL,
  position        INTEGER NOT NULL,
  selected_option TEXT,                                   -- A-D, IDK, or null if never answered
  is_correct      INTEGER CHECK (is_correct IN (0, 1)),
  shown_at        TEXT NOT NULL,                          -- first time the server served the question
  answered_at     TEXT,
  time_taken_ms   INTEGER,
  expired         INTEGER NOT NULL DEFAULT 0 CHECK (expired IN (0, 1)),   -- closed by the time limit
  idempotency_key TEXT,
  UNIQUE (participant_id, question_id)
);

CREATE TABLE IF NOT EXISTS gamification_events (
  id             INTEGER PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  type           TEXT NOT NULL,
  key            TEXT NOT NULL,
  value          INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY,
  participant_id TEXT REFERENCES participants(id),
  event_type     TEXT NOT NULL,
  payload        TEXT,
  created_at     TEXT NOT NULL
);

-- The audit log is append-only.
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE INDEX IF NOT EXISTS idx_survey_participant ON survey_responses (participant_id);
CREATE INDEX IF NOT EXISTS idx_questions_participant ON question_responses (participant_id);
CREATE INDEX IF NOT EXISTS idx_game_participant ON gamification_events (participant_id);
CREATE INDEX IF NOT EXISTS idx_events_participant ON events (participant_id);
CREATE INDEX IF NOT EXISTS idx_slots_unclaimed ON allocation_slots (list, claimed_by, seq_no);
