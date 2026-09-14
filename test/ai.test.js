import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, extractHttpContent, buildPrompt } from '../src/ai.js';

test('parseVerdict: 提取 JSON 并校验字段', () => {
  const verdict = parseVerdict('前置噪声 {"is_reset": true, "confidence": 0.9, "reason": "公告"} 后置噪声');
  assert.equal(verdict.isReset, true);
  assert.equal(verdict.confidence, 0.9);
  assert.equal(verdict.reason, '公告');
  assert.equal(parseVerdict('没有 JSON'), null);
  assert.equal(parseVerdict('{"is_reset": "yes"}'), null);
});

test('extractHttpContent: OpenAI 字符串与数组', () => {
  assert.equal(
    extractHttpContent({ choices: [{ message: { content: '{"is_reset":false}' } }] }, 'openai'),
    '{"is_reset":false}',
  );
  assert.equal(
    extractHttpContent(
      { choices: [{ message: { content: [{ text: 'a' }, { type: 'text', text: 'b' }] } }] },
      'openai',
    ),
    'ab',
  );
});

test('extractHttpContent: Anthropic 内容块', () => {
  assert.equal(
    extractHttpContent({ content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] }, 'anthropic'),
    'hello world',
  );
});

test('buildPrompt: 包含判定标准与推文', () => {
  const prompt = buildPrompt('Reset all propagated. Sweet dreams.');
  assert.ok(prompt.includes('Reset all propagated'));
  assert.ok(prompt.includes('is_reset'));
});
