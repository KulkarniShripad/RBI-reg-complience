import { describe, expect, it } from 'vitest';
import { ANSWER_KEY, fullRun, makeApp, wrongLetter } from '../helpers.js';

describe('load', () => {
  it('50 participants at once all finish with no errors and balanced arms', async () => {
    const { app, db, content } = makeApp();
    const runs = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        fullRun(app, content, { choose: (id, n) => ((n + i) % 3 === 0 ? wrongLetter(ANSWER_KEY[id]) : ANSWER_KEY[id]) }),
      ),
    );
    expect(runs).toHaveLength(50);
    for (const run of runs) expect(run.p.log.every((e) => e.status < 400)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'error'").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM participants WHERE status = 'completed'").get().n).toBe(50);
    const arms = Object.fromEntries(db.prepare('SELECT arm, COUNT(*) AS n FROM participants GROUP BY arm').all().map((r) => [r.arm, r.n]));
    expect(Math.abs(arms.control - arms.experimental)).toBeLessThanOrEqual(1);
    expect(db.prepare('SELECT COUNT(DISTINCT allocation_slot_id) AS n FROM participants').get().n).toBe(50);
    expect(db.prepare('SELECT COUNT(*) AS n FROM question_responses').get().n).toBe(450);
  });
});
