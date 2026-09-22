import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Poller } from '../src/poller.js';
import { openStore } from '../src/store.js';
import { DEFAULTS } from '../src/config.js';

for (const before of [false, true]) {
  for (const after of [false, true]) {
    test(`AI ${before} → ${after}: 推送判定详情，仅新增命中触发警报，保留缓存`, async (t) => {
      const store = openStore(':memory:');
      t.after(() => store.close());
      const createdAt = '2026-01-01T00:00:00.000Z';
      const tweet = {
        id: 'test-reset',
        text: "We will reset everyone's limits tomorrow.",
        createdAt,
        createdTs: Date.parse(createdAt),
      };
      store.upsertTweets([tweet]);
      store.setDetection(tweet.id, { isReset: before, score: before ? 3 : 0, signals: [] });

      let requests = 0;
      t.mock.method(globalThis, 'fetch', async (url) => {
        assert.equal(url, 'https://ai.invalid/test');
        requests += 1;
        return Response.json({
          choices: [{ message: { content: JSON.stringify({
            is_reset: after,
            confidence: 0.9,
            reason: after ? '重置预告，尚未发放' : '常规周期说明',
          }) } }],
        });
      });

      const poller = new Poller({
        config: {
          ...DEFAULTS,
          notify: false,
          ocrEnabled: false,
          aiEngine: 'http',
          aiHttpUrl: 'https://ai.invalid/test',
          aiHttpModel: 'fixture',
        },
        store,
        fetchImpl: async () => [],
      });
      const updates = [];
      const alerts = [];
      poller.on('tweets', (tweets) => updates.push(...tweets));
      poller.on('alert', (alert) => alerts.push(alert));

      const result = await poller.pollOnce();
      assert.equal(result.ok, true);
      assert.equal(result.aiJudged, 1);
      assert.equal(updates.length, 1);
      assert.equal(updates[0].aiVerdict, after);
      assert.equal(updates[0].aiConfidence, 0.9);
      assert.equal(updates[0].aiEngine, 'http');
      assert.equal(updates[0].aiReason, after ? '重置预告，尚未发放' : '常规周期说明');
      assert.equal(alerts.length, !before && after ? 1 : 0);

      const cachedAt = store.getTweet(tweet.id).aiAt;
      const next = await poller.pollOnce();
      assert.equal(next.aiJudged, 0);
      assert.equal(requests, 1);
      assert.equal(store.getTweet(tweet.id).aiAt, cachedAt);
    });
  }
}
