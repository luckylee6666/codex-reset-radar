import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function createFeed(tweets, filter = 'all') {
  const elements = new Map();
  let handlers;
  const context = vm.createContext({
    navigator: { userAgent: 'test' },
    window: { matchMedia: () => ({ matches: false }) },
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, {});
        return elements.get(selector);
      },
    },
    Platform: { kind: 'http', subscribe: (value) => { handlers = value; } },
    alertReloads: 0,
  });
  // 保留真实事件处理与 HTML 渲染，仅替换启动和警报接口以隔离浏览器与网络。
  vm.runInContext(`${source}
    async function boot() {}
    async function loadAlerts() { globalThis.alertReloads += 1; }
    globalThis.feedState = state;
    connectEvents();
  `, context);
  const state = context.feedState;
  state.tweets = tweets.map((tweet) => ({ ...tweet }));
  state.tweetIds = new Set(tweets.map((tweet) => tweet.id));
  state.tweetsTotal = tweets.length;
  state.filter = filter;
  return { state, elements, handlers, context };
}

const tweet = {
  id: 'reset-preview',
  text: 'I promised a reset for Tuesday. See you soon.',
  isReset: false,
  aiVerdict: null,
  createdTs: 1,
  media: [],
};

test('同一条推文收到 AI 否决后显示理由，不重复计数，保留译文折叠状态', () => {
  const { state, elements, handlers } = createFeed([{ ...tweet, showTranslation: false }]);
  const update = { ...tweet, aiVerdict: false, aiConfidence: 0.88, aiReason: '常规周期说明', aiEngine: 'codex' };
  handlers.tweets([update]);
  handlers.tweets([update]);
  assert.equal(state.tweets.length, 1);
  assert.equal(state.tweetsTotal, 1);
  assert.equal(state.tweets[0].showTranslation, false);
  assert.match(elements.get('#feed').innerHTML, /AI ✗ 非公告/);
  assert.match(elements.get('#feed').innerHTML, /常规周期说明/);
});

test('AI 推翻规则命中时从仅重置列表移除，并刷新警报', () => {
  const { state, handlers, context } = createFeed([{ ...tweet, isReset: true }], 'reset');
  handlers.tweets([{ ...tweet, aiVerdict: false, aiReason: '非公告' }]);
  assert.equal(state.tweets.length, 0);
  assert.equal(state.tweetsTotal, 0);
  assert.equal(context.alertReloads, 1);
});

test('AI 确认预告后更新现有卡片，而不是追加重复项', () => {
  const { state, elements, handlers, context } = createFeed([tweet]);
  handlers.tweets([{ ...tweet, isReset: true, aiVerdict: true, aiReason: '重置预告，尚未发放' }]);
  assert.equal(state.tweets.length, 1);
  assert.equal(state.tweetsTotal, 1);
  assert.match(elements.get('#feed').innerHTML, /重置预告，尚未发放/);
  assert.equal(context.alertReloads, 1);
});
