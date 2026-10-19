import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { E2E_ADMIN_TOKEN } from '../../playwright.config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'content', file), 'utf8'));
const { questions } = read('questions.json');
const answerKey = read('answer_key.json');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const shoot = (page, name) => (process.env.SCREENSHOTS ? page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }) : null);

// Catches rendering slips like a literal "null"/"undefined" or a visible empty error banner.
async function expectCleanScreen(page) {
  expect(await page.locator('body').innerText()).not.toMatch(/\bnull\b|\bundefined\b|\[object Object\]/);
  await expect(page.locator('#banner')).toBeHidden();
}

async function fillSurvey(page) {
  const sets = page.locator('fieldset.likert');
  const count = await sets.count();
  for (let i = 0; i < count; i++) await sets.nth(i).locator('input[type=radio]').nth(4).check();
}

// Plays one participant through the whole study; returns what the browser showed.
async function playThrough(page, label, { wrongOn = [] } = {}) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Before you begin' })).toBeVisible();
  const start = page.getByRole('button', { name: 'Start', exact: true });
  await expect(start).toBeDisabled();
  await expectCleanScreen(page);
  if (label === 'first') await shoot(page, '01-consent');
  await page.getByLabel(/I agree to take part/).check();
  await start.click();

  await expect(page.getByRole('heading', { name: 'Before the questions' })).toBeVisible();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Please answer every statement before continuing.')).toBeVisible();
  await fillSurvey(page);
  await expectCleanScreen(page);
  if (label === 'first') await shoot(page, '02-pre-survey');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expect(page.getByRole('heading', { name: 'Instructions' })).toBeVisible();
  await expectCleanScreen(page);
  await page.getByRole('button', { name: 'Start question 1' }).click();

  let sawGamePanel = false;
  for (const [i, q] of questions.entries()) {
    await expect(page.getByRole('heading', { name: `Question ${i + 1} of 9` })).toBeVisible();
    // Rendered text equals the content file exactly (Appendix A).
    if (q.prompt) await expect(page.getByTestId('prompt')).toHaveText(q.prompt);
    else await expect(page.getByTestId('prompt')).toHaveCount(0);
    if (q.code !== undefined) expect(await page.getByTestId('code').evaluate((el) => el.textContent)).toBe(q.code);
    await expectCleanScreen(page);
    const optionTexts = await page.locator('.option-text').allTextContents();
    expect(optionTexts).toEqual(q.options.map((o) => o.text));

    if (i === 3) {
      // Closing and reopening at a question lands on the same question.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Question 4 of 9' })).toBeVisible();
    }
    const letter = wrongOn.includes(q.id) ? { A: 'B', B: 'C', C: 'D', D: 'A' }[answerKey[q.id]] : answerKey[q.id];
    await page.locator(`input[name=answer][value=${letter}]`).check();
    if (label === 'first' && i === 5) await shoot(page, '03-question');
    await page.getByRole('button', { name: 'Submit answer' }).click();
    await expect(page.getByTestId('result')).toHaveText(wrongOn.includes(q.id) ? 'Incorrect' : 'Correct');
    await expectCleanScreen(page);
    const panel = await page.getByTestId('game-panel').count();
    sawGamePanel ||= panel > 0;
    if (i === 4) await shoot(page, `04-feedback-${panel ? 'experimental' : 'control'}`);
    await page.getByRole('button', { name: i < 8 ? 'Next question' : 'Continue' }).click();
  }

  await expect(page.getByRole('heading', { name: 'You have finished the questions' })).toBeVisible();
  await expectCleanScreen(page);
  const score = await page.getByTestId('score').textContent();
  const leaderboard = await page.getByTestId('leaderboard').count();
  await shoot(page, `05-final-${sawGamePanel ? 'experimental' : 'control'}`);
  await page.getByRole('button', { name: 'Continue to the last survey' }).click();

  await expect(page.getByRole('heading', { name: 'After the questions' })).toBeVisible();
  await fillSurvey(page);
  await page.getByRole('button', { name: 'Submit' }).click();

  await expect(page.getByRole('heading', { name: 'Thank you for taking part' })).toBeVisible();
  await expectCleanScreen(page);
  const code = (await page.getByTestId('participant-code').textContent()).trim();
  if (label === 'first') await shoot(page, '06-debrief');
  // Reload after finishing shows the same debrief, not the start.
  await page.reload();
  await expect(page.getByTestId('participant-code')).toHaveText(code);
  return { code, score, sawGamePanel, leaderboard };
}

function parseCsv(text) {
  const [header, ...lines] = text.trim().split('\n').map((l) => l.split(','));
  return lines.map((cols) => Object.fromEntries(header.map((h, i) => [h, cols[i]])));
}

test('a Control and an Experimental participant complete the study; the CSVs match', async ({ browser, request }) => {
  if (process.env.SCREENSHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  // Block size 2: the first two participants always get one arm each.
  const first = await (await browser.newContext()).newPage();
  const a = await playThrough(first, 'first', { wrongOn: ['Q2', 'Q6'] });
  const second = await (await browser.newContext()).newPage();
  const b = await playThrough(second, 'second', { wrongOn: ['Q5'] });

  expect([a.sawGamePanel, b.sawGamePanel].sort()).toEqual([false, true]);
  const exp = a.sawGamePanel ? a : b;
  const ctrl = a.sawGamePanel ? b : a;
  expect(exp.leaderboard).toBe(1);
  expect(ctrl.leaderboard).toBe(0);
  expect(a.score).toBe('You answered 7 of 9 questions correctly.');
  expect(b.score).toBe('You answered 8 of 9 questions correctly.');

  const csv = await request.get('/admin/api/export/participants.csv', { headers: { 'X-Admin-Token': E2E_ADMIN_TOKEN } });
  expect(csv.status()).toBe(200);
  const rows = Object.fromEntries(parseCsv(await csv.text()).map((r) => [r.participant_code, r]));
  expect(rows[exp.code]).toMatchObject({ arm: 'experimental', arm_code: '1', status: 'completed' });
  expect(rows[ctrl.code]).toMatchObject({ arm: 'control', arm_code: '0', status: 'completed' });
  expect(rows[a.code].score_raw).toBe('7');
  expect(rows[b.code].score_raw).toBe('8');

  const status = await (await request.get('/admin/api/status', { headers: { 'X-Admin-Token': E2E_ADMIN_TOKEN } })).json();
  expect(status.live.by_arm.control.completed).toBe(1);
  expect(status.live.by_arm.experimental.completed).toBe(1);
});

test('declining consent stores nothing; stopping part-way shows the stopped page', async ({ browser, request }) => {
  const headers = { 'X-Admin-Token': E2E_ADMIN_TOKEN };
  const before = (await (await request.get('/admin/api/status', { headers })).json()).live.total;

  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await page.getByRole('button', { name: 'I do not want to take part' }).click();
  await expect(page.getByText('Nothing has been recorded.')).toBeVisible();
  expect((await (await request.get('/admin/api/status', { headers })).json()).live.total).toBe(before);

  const quitter = await (await browser.newContext()).newPage();
  await quitter.goto('/');
  await quitter.getByLabel(/I agree to take part/).check();
  await quitter.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(quitter.getByRole('heading', { name: 'Before the questions' })).toBeVisible();
  quitter.once('dialog', (d) => d.accept());
  await quitter.getByRole('button', { name: 'Stop taking part' }).click();
  await expect(quitter.getByRole('heading', { name: 'You have stopped taking part' })).toBeVisible();
  await quitter.reload();
  await expect(quitter.getByRole('heading', { name: 'You have stopped taking part' })).toBeVisible();
  const after = (await (await request.get('/admin/api/status', { headers })).json()).live;
  expect(after.total).toBe(before + 1);
  expect(after.by_status.abandoned).toBe(1);
});

test('a network drop is retried with the same key; a longer outage shows "connection lost"', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await page.getByLabel(/I agree to take part/).check();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Before the questions' })).toBeVisible();
  await fillSurvey(page);
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByRole('button', { name: 'Start question 1' }).click();
  await expect(page.getByRole('heading', { name: 'Question 1 of 9' })).toBeVisible();

  // Two dropped requests, then the network comes back: the answer goes through once.
  const keys = [];
  let drops = 2;
  await page.route('**/api/answer', async (route) => {
    keys.push(JSON.parse(route.request().postData()).idempotencyKey);
    if (drops-- > 0) return route.abort('internetdisconnected');
    return route.continue();
  });
  await page.locator('input[name=answer][value=D]').check();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByTestId('result')).toHaveText('Correct');
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  await page.unroute('**/api/answer');

  // A longer outage: 1 try + 3 retries, then the proctor message; Try again recovers.
  await page.getByRole('button', { name: 'Next question' }).click();
  await expect(page.getByRole('heading', { name: 'Question 2 of 9' })).toBeVisible();
  let attempts = 0;
  await page.route('**/api/answer', (route) => {
    attempts++;
    return route.abort('internetdisconnected');
  });
  await page.locator('input[name=answer][value=C]').check();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('alert')).toContainText('Connection lost. Please raise your hand and tell the proctor.');
  expect(attempts).toBe(4);
  await page.unroute('**/api/answer');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Question 2 of 9' })).toBeVisible();
  await page.locator('input[name=answer][value=C]').check();
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByTestId('result')).toHaveText('Correct');
});

test('the admin page shows live counts after logging in', async ({ page }) => {
  await page.goto('/admin');
  await page.getByLabel('Admin token').fill('wrong');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByText('Wrong or missing admin token.')).toBeVisible();
  await page.getByLabel('Admin token').fill(E2E_ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Live participants by arm' })).toBeVisible();
  await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
  await shoot(page, '07-admin-status');
});
