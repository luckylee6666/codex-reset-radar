import { EventEmitter } from 'node:events';
import { fetchTimeline, fetchFromRss, discoverTweetIds, fetchTweetWithRelated } from './fetch.js';
import { detectReset } from './detect.js';
import { judgeTweet, listAvailableEngines } from './ai.js';
import { runOcrPass, combinedText } from './ocr.js';
import { notifyMac } from './notify.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIN_INTERVAL_SEC = 60;
const MAX_TIMELINE_BACKOFF = 8;
const AI_CANDIDATE_RE = /\b(?:reset|refill|replenish|top.?up|banked)\w*/i;

function ageText(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export class Poller extends EventEmitter {
  #config;
  #store;
  #fetchImpl;
  #timer = null;
  #running = false;
  #checking = false;
  #timelineBackoff = 1;
  #nextTimelineAt = 0;
  #lastTimelineOkAt = 0;
  #lastDiscoveryAt = 0;
  #lastDiscoveryOkAt = 0;

  constructor({ config, store, fetchImpl = null }) {
    super();
    this.#config = config;
    this.#store = store;
    this.#fetchImpl = fetchImpl;
    this.status = {
      running: false,
      checking: false,
      phase: 'idle',
      lastCheckAt: null,
      nextCheckAt: null,
      lastError: null,
      lastSource: null,
      consecutiveErrors: 0,
      intervalSec: config.intervalSec,
      discoveredIds: 0,
      discoveryFetched: 0,
      aiJudged: 0,
      aiEngines: null,
      ocrApplied: 0,
    };
  }

  get config() {
    return this.#config;
  }

  async #fetchTimeline() {
    if (this.#fetchImpl) {
      this.status.timelineSource = 'fixture';
      return this.#fetchImpl();
    }
    try {
      const tweets = await fetchTimeline(this.#config.handle);
      this.status.timelineSource = 'syndication';
      return tweets;
    } catch (err) {
      if (!this.#config.rssUrl) throw err;
      try {
        const tweets = await fetchFromRss(this.#config.rssUrl);
        this.status.timelineSource = 'rss';
        return tweets;
      } catch (rssErr) {
        err.message = `${err.message}；RSS 备用源也失败：${rssErr.message}`;
        throw err;
      }
    }
  }

  async #collectTweets() {
    if (this.#fetchImpl) return this.#fetchTimeline();

    const merged = new Map();
    const sources = [];
    let timelineOk = false;
    let timelineFailure = null;
    let discoveryOk = false;
    let discoveryAttempted = false;

    const intervalMs = Math.max(MIN_INTERVAL_SEC, Number(this.#config.intervalSec) || 300) * 1000;
    const discoveryIntervalMs =
      Math.max(MIN_INTERVAL_SEC, Number(this.#config.discoveryIntervalSec) || 600) * 1000;

    /* 时间线：成败只影响自己的重试节奏，不拖累搜索发现 */
    if (Date.now() >= this.#nextTimelineAt) {
      try {
        for (const tweet of await this.#fetchTimeline()) merged.set(tweet.id, tweet);
        sources.push(this.status.timelineSource ?? 'timeline');
        timelineOk = true;
        this.#lastTimelineOkAt = Date.now();
        this.#timelineBackoff = 1;
      } catch (err) {
        timelineFailure = err?.message ?? String(err);
        this.#timelineBackoff = Math.min(this.#timelineBackoff * 2, MAX_TIMELINE_BACKOFF);
        const retryAfter = (err?.retryAfter ?? 0) * 1000;
        this.#nextTimelineAt =
          Date.now() + Math.max(intervalMs * this.#timelineBackoff, retryAfter);
      }
    }

    /* 搜索发现：按自己的间隔运行，和时间线退避无关 */
    if (this.#config.searchDiscovery !== false) {
      if (Date.now() - this.#lastDiscoveryAt >= discoveryIntervalMs) {
        this.#lastDiscoveryAt = Date.now();
        const { ids, source, attempted } = await discoverTweetIds(this.#config.handle);
        discoveryAttempted = attempted;
        if (source) {
          discoveryOk = true;
          this.#lastDiscoveryOkAt = Date.now();
          sources.push(source);
        }

        const unseen = ids.filter((id) => !this.#store.hasTweet(id) && !merged.has(id));
        const limit = Math.max(1, Math.min(30, Number(this.#config.discoveryMaxFetch) || 10));
        let fetched = 0;
        for (const id of unseen.slice(0, limit)) {
          try {
            const { tweet, related } = await fetchTweetWithRelated(id, this.#config.handle);
            merged.set(tweet.id, tweet);
            fetched += 1;
            for (const parent of related) {
              if (!this.#store.hasTweet(parent.id) && !merged.has(parent.id)) {
                merged.set(parent.id, parent);
              }
            }
          } catch {
            // 单推可能已删除或接口失败，跳过
          }
          await sleep(350);
        }
        this.status.discoveredIds = ids.length;
        this.status.discoveryFetched = fetched;
      }
    }

    const timelineFresh = Date.now() - this.#lastTimelineOkAt < 3 * intervalMs;
    const discoveryFresh = Date.now() - this.#lastDiscoveryOkAt < 3 * discoveryIntervalMs;
    const anySourceHealthy = timelineOk || timelineFresh || discoveryOk || discoveryFresh;

    if (!merged.size && !anySourceHealthy) {
      const message =
        timelineFailure ??
        (discoveryAttempted ? '搜索发现暂时不可用' : '所有数据源暂时不可用');
      throw new Error(message);
    }

    if (sources.length) this.status.lastSource = sources.join('+');
    this.status.lastError = timelineOk || discoveryOk ? null : timelineFailure;
    return [...merged.values()].sort((a, b) => a.createdTs - b.createdTs);
  }

  setConfig(next) {
    const wasRunning = this.#running;
    if (wasRunning) this.stop();
    this.#config = next;
    this.status.intervalSec = next.intervalSec;
    if (wasRunning) this.start();
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.status.running = true;
    this.#emitStatus({ phase: 'idle' });
    this.#schedule(200);
  }

  stop() {
    this.#running = false;
    this.status.running = false;
    this.status.nextCheckAt = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#emitStatus({ phase: 'paused' });
  }

  async pollOnce(trigger = 'manual') {
    if (this.#checking) return { skipped: true };
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#checking = true;
    this.status.checking = true;
    this.#emitStatus({ phase: 'checking' });
    const started = Date.now();

    try {
      const tweets = await this.#collectTweets();
      const result = await this.ingest(tweets, { source: 'live' });
      const ocrApplied = await this.#ocrPass();
      const aiJudged = await this.#judgeWithAi();

      this.status.consecutiveErrors = 0;
      this.status.lastCheckAt = Date.now();

      const newest = tweets[tweets.length - 1];
      if (newest) {
        this.#store.setMeta('account', {
          handle: newest.authorHandle || this.#config.handle,
          name: newest.authorName || '',
          avatar: newest.avatar || '',
        });
      }
      this.#store.setMeta('lastPoll', {
        at: this.status.lastCheckAt,
        fetched: tweets.length,
        inserted: result.inserted.length,
        trigger,
      });

      this.#emitStatus({ phase: 'ok' });
      this.emit('stats', this.#store.getStats());
      return {
        ok: true,
        fetched: tweets.length,
        inserted: result.inserted.length,
        alerts: result.alerts.length,
        notified: result.notified,
        aiJudged,
        ocrApplied,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      this.status.consecutiveErrors += 1;
      this.status.lastError = err?.message ?? String(err);
      this.#emitStatus({ phase: 'error' });
      const ocrApplied = await this.#ocrPass().catch(() => 0);
      const aiJudged = await this.#judgeWithAi().catch(() => 0);
      return { ok: false, error: this.status.lastError, aiJudged, ocrApplied };
    } finally {
      this.#checking = false;
      this.status.checking = false;
      if (this.#running) {
        this.#schedule(Math.max(MIN_INTERVAL_SEC, Number(this.#config.intervalSec) || 300) * 1000);
      }
    }
  }

  async #ocrPass() {
    if (this.#config.ocrEnabled === false) return 0;
    let result;
    try {
      result = await runOcrPass({ store: this.#store, config: this.#config });
    } catch (err) {
      this.emit('ocr-error', err.message);
      return 0;
    }
    if (result.changed.length) {
      this.emit('tweets', result.changed);
      for (const tweet of result.changed) {
        if (tweet.isReset) {
          this.emit('alert', {
            tweet,
            detection: { isReset: true, score: tweet.resetScore, signals: tweet.resetSignals },
          });
        }
      }
      await this.notifyPendingFresh();
      this.emit('stats', this.#store.getStats());
    }
    this.status.ocrApplied = result.ocrApplied;
    return result.ocrApplied;
  }

  async #judgeWithAi() {
    if (this.#config.aiJudge === false) return 0;
    const maxPerPoll = Math.max(1, Math.min(10, Number(this.#config.aiMaxPerPoll) || 3));
    const candidates = this.#store
      .pendingAiCandidates(150)
      .filter((tweet) => AI_CANDIDATE_RE.test(tweet.text))
      .slice(0, maxPerPoll);
    if (!candidates.length) return 0;

    const engines = await listAvailableEngines({
      httpUrl: this.#config.aiHttpUrl,
      httpModel: this.#config.aiHttpModel,
      engine: this.#config.aiEngine,
    });
    this.status.aiEngines = engines;
    if (!engines.length) return 0;

    let judged = 0;
    const changed = [];
    for (const tweet of candidates) {
      const verdict = await judgeTweet(combinedText(tweet), {
        engine: this.#config.aiEngine || 'auto',
        timeoutSec: Math.max(20, Number(this.#config.aiTimeoutSec) || 90),
        ollamaModel: this.#config.aiOllamaModel || '',
        httpUrl: this.#config.aiHttpUrl || '',
        httpKey: this.#config.aiHttpKey || '',
        httpModel: this.#config.aiHttpModel || '',
        httpFormat: this.#config.aiHttpFormat || 'openai',
      });
      if (verdict.error) {
        this.emit('ai-error', verdict.error);
        break;
      }
      this.#store.setAiVerdict(tweet.id, verdict);
      judged += 1;
      const updated = this.#store.getTweet(tweet.id);
      if (updated && updated.isReset !== tweet.isReset) changed.push(updated);
    }

    if (changed.length) {
      this.emit('tweets', changed);
      for (const tweet of changed) {
        if (tweet.isReset) {
          this.emit('alert', {
            tweet,
            detection: { isReset: true, score: tweet.resetScore, signals: tweet.resetSignals },
          });
        }
      }
      await this.notifyPendingFresh();
    }

    this.status.aiJudged = judged;
    this.status.aiEngine = candidates.length ? this.status.aiEngine : null;
    return judged;
  }

  async ingest(tweets, { source = 'live' } = {}) {
    const { inserted } = this.#store.upsertTweets(tweets, source);
    const alerts = [];

    for (const tweet of inserted) {
      const detection = detectReset(tweet.text, {
        extraKeywords: this.#config.extraKeywords,
        threshold: this.#config.resetThreshold,
      });
      this.#store.setDetection(tweet.id, detection);
      if (detection.isReset) {
        alerts.push({ tweet: this.#store.getTweet(tweet.id), detection });
      }
    }

    if (inserted.length) {
      this.emit('tweets', inserted.map((t) => this.#store.getTweet(t.id)));
      for (const alert of alerts) this.emit('alert', alert);
    }

    const notified = inserted.length ? await this.notifyPendingFresh() : 0;
    return { inserted, alerts, notified };
  }

  async notifyPendingFresh() {
    const fresh = this.#store.pendingFreshAlerts(this.#config.freshHours);
    if (!fresh.length) return 0;

    if (this.#config.notify) {
      const sound = this.#config.notifySound || undefined;
      for (const tweet of fresh.slice(0, 3)) {
        await notifyMac({
          title: tweet.source === 'simulate' ? 'Codex 重置信号（模拟）' : 'Codex 重置信号',
          subtitle: `${ageText(Date.now() - tweet.createdTs)} · @${tweet.authorHandle || this.#config.handle}`,
          message: tweet.text.replace(/\s+/g, ' '),
          sound,
        }).catch((err) => this.emit('notify-error', err.message));
      }
      if (fresh.length > 3) {
        await notifyMac({
          title: 'Codex 重置信号',
          subtitle: `另有 ${fresh.length - 3} 条公告`,
          message: '打开 Codex Reset Radar 查看全部',
          sound,
        }).catch(() => {});
      }
    }

    this.#store.markNotified(fresh.map((t) => t.id));
    return fresh.length;
  }

  #schedule(ms) {
    if (!this.#running) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.status.nextCheckAt = Date.now() + ms;
    this.#timer = setTimeout(() => this.pollOnce('scheduled'), ms);
    this.#emitStatus({});
  }

  #emitStatus(patch) {
    Object.assign(this.status, patch);
    this.emit('status', { ...this.status });
  }
}
