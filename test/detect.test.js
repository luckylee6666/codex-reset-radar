import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectReset } from '../src/detect.js';

const positives = [
  "We've reset the Codex rate limits for all users. Enjoy!",
  'Codex limits reset! Go wild.',
  'Rate limits have been reset.',
  'We just reset usage limits — thanks for your patience.',
  'We are resetting limits right now.',
  "Refilled everyone's Codex usage for the weekend.",
  'Resetting the 5h limits shortly, hang tight.',
  'Good news: we topped up your credit allowances.',
  'During the day we will credit every Codex and ChatGPT Work user with a BANKED reset. Enjoy!',
  'Hi Astra users. A reset and a quick update on quality issues that have been posted around.',
];

const negatives = [
  'git reset --hard HEAD',
  "Don't forget to reset your password",
  'We reset the staging environment and redeployed.',
  'Codex CLI v0.52 is out. Lots of polish, further reduction in crashes.',
  'Your limits will reset at 3pm.',
  'Limits reset every 5 hours automatically.',
  'We raised the Codex usage limits this week.',
  'Click the reset button in settings.',
  'I just reset my local Codex config.',
  'The 5h window resets in 2 hours.',
  'Upgrade to the latest Codex CLI version to see when limits reset by typing /status.',
  'Check /status to see when your limits reset.',
  'Update. I have decided to take a break from x to recharge a bit. See you soon.',
  'I feel Theo is in need of a reset 👀',
  'Codex ✅ Almost 100% reliable ✅ Occasional resets ✅ Open-source',
  'Here you are! Thinking I am about to announce a reset. But no.',
  'Reset all propagated. Sweet dreams.',
  'The reset is fully propagated now, all systems green.',
];

test('positive: reset announcements are detected', () => {
  for (const text of positives) {
    const result = detectReset(text);
    assert.equal(result.isReset, true, `应触发：${text}（得分 ${result.score}）`);
  }
});

test('negative: unrelated resets are ignored', () => {
  for (const text of negatives) {
    const result = detectReset(text);
    assert.equal(result.isReset, false, `不应触发：${text}（得分 ${result.score}）`);
  }
});

test('typo 容忍：reseting / resetted', () => {
  const result = detectReset('We are reseting usage for all paid users of Codex and ChatGPT Work.');
  assert.equal(result.isReset, true, `得分 ${result.score}`);
  const result2 = detectReset('We resetted the limits, enjoy');
  assert.equal(result2.isReset, true, `得分 ${result2.score}`);
});

test('threshold is configurable', () => {
  const text = 'Codex limits reset!';
  assert.equal(detectReset(text).isReset, true);
  assert.equal(detectReset(text, { threshold: 9 }).isReset, false);
});

test('custom keywords trigger detection', () => {
  const result = detectReset('Big news: the refill wave is here', {
    extraKeywords: ['refill wave'],
  });
  assert.equal(result.isReset, true);
  assert.ok(result.signals.some((s) => s.id === 'custom-keyword'));
});

test('signals carry weights and labels', () => {
  const result = detectReset("We've reset the Codex rate limits for all users");
  const ids = result.signals.map((s) => s.id);
  assert.ok(ids.includes('limit-reset-proximity'));
  assert.ok(ids.includes('announce'));
  assert.ok(ids.includes('codex-context'));
  assert.ok(result.score >= 6);
});
