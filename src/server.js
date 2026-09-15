import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA_DIR, saveConfig } from './config.js';
import { getRuleInfo, detectReset } from './detect.js';
import { listAvailableEngines, judgeTweet, translateText, aiOptionsFromConfig } from './ai.js';
import { ocrStatus } from './ocr.js';
import { notifyMac } from './notify.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const IMG_HOSTS = new Set(['pbs.twimg.com', 'abs.twimg.com', 'ton.twimg.com']);
const IMG_DIR = path.join(DATA_DIR, 'img-cache');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('请求体过大');
  }
  return body ? JSON.parse(body) : {};
}

function sanitizeConfigPatch(patch) {
  const out = {};
  if (patch.intervalSec !== undefined) out.intervalSec = clamp(Number(patch.intervalSec) || 600, 600, 7200);
  if (patch.notify !== undefined) out.notify = Boolean(patch.notify);
  if (patch.notifySound !== undefined) out.notifySound = String(patch.notifySound).slice(0, 40);
  if (patch.freshHours !== undefined) out.freshHours = clamp(Number(patch.freshHours) || 0, 0, 168);
  if (patch.resetThreshold !== undefined) out.resetThreshold = clamp(Number(patch.resetThreshold) || 3, 1, 10);
  if (patch.openBrowser !== undefined) out.openBrowser = Boolean(patch.openBrowser);
  if (patch.extraKeywords !== undefined) {
    out.extraKeywords = Array.isArray(patch.extraKeywords)
      ? patch.extraKeywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 20)
      : [];
  }
  if (patch.rssUrl !== undefined) {
    out.rssUrl = /^https?:\/\//.test(String(patch.rssUrl)) ? String(patch.rssUrl).slice(0, 500) : '';
  }
  if (patch.searchDiscovery !== undefined) out.searchDiscovery = Boolean(patch.searchDiscovery);
  if (patch.discoveryMaxFetch !== undefined) {
    out.discoveryMaxFetch = clamp(Number(patch.discoveryMaxFetch) || 10, 1, 30);
  }
  if (patch.discoveryIntervalSec !== undefined) {
    out.discoveryIntervalSec = clamp(Number(patch.discoveryIntervalSec) || 300, 60, 3600);
  }
  if (patch.profileScrape !== undefined) out.profileScrape = Boolean(patch.profileScrape);
  if (patch.xAuthToken !== undefined) {
    if (patch.xAuthToken === null) out.xAuthToken = '';
    else {
      const token = String(patch.xAuthToken).trim();
      if (token) out.xAuthToken = token.slice(0, 200);
    }
  }
  if (patch.xCt0 !== undefined) {
    if (patch.xCt0 === null) out.xCt0 = '';
    else {
      const token = String(patch.xCt0).trim();
      if (token) out.xCt0 = token.slice(0, 200);
    }
  }
  if (patch.xUserTweetsQueryId !== undefined) {
    out.xUserTweetsQueryId = String(patch.xUserTweetsQueryId).trim().slice(0, 60);
  }
  if (patch.aiJudge !== undefined) out.aiJudge = Boolean(patch.aiJudge);
  if (patch.aiEngine !== undefined) {
    const engine = String(patch.aiEngine);
    out.aiEngine = ['auto', 'http', 'claude', 'codex', 'ollama'].includes(engine) ? engine : 'auto';
  }
  if (patch.aiMaxPerPoll !== undefined) out.aiMaxPerPoll = clamp(Number(patch.aiMaxPerPoll) || 3, 1, 10);
  if (patch.aiTimeoutSec !== undefined) out.aiTimeoutSec = clamp(Number(patch.aiTimeoutSec) || 90, 20, 300);
  if (patch.aiOllamaModel !== undefined) out.aiOllamaModel = String(patch.aiOllamaModel).slice(0, 60);
  if (patch.aiHttpUrl !== undefined) {
    const url = String(patch.aiHttpUrl).trim();
    out.aiHttpUrl = /^https?:\/\//.test(url) ? url.slice(0, 500) : '';
  }
  if (patch.aiHttpKey !== undefined) {
    if (patch.aiHttpKey === null) out.aiHttpKey = '';
    else {
      const key = String(patch.aiHttpKey).trim();
      if (key) out.aiHttpKey = key.slice(0, 500);
    }
  }
  if (patch.aiHttpModel !== undefined) out.aiHttpModel = String(patch.aiHttpModel).trim().slice(0, 80);
  if (patch.aiHttpFormat !== undefined) {
    out.aiHttpFormat = String(patch.aiHttpFormat) === 'anthropic' ? 'anthropic' : 'openai';
  }
  if (patch.ocrEnabled !== undefined) out.ocrEnabled = Boolean(patch.ocrEnabled);
  if (patch.ocrMaxPerPoll !== undefined) out.ocrMaxPerPoll = clamp(Number(patch.ocrMaxPerPoll) || 2, 1, 5);
  if (patch.ocrMaxAgeDays !== undefined) out.ocrMaxAgeDays = clamp(Number(patch.ocrMaxAgeDays) || 7, 1, 60);
  if (patch.handle !== undefined) {
    out.handle =
      String(patch.handle)
        .replace(/[^A-Za-z0-9_]/g, '')
        .slice(0, 30) || 'thsottiaux';
  }
  return out;
}

export function createServer({ store, poller, config }) {
  const clients = new Set();

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  poller.on('status', (status) => broadcast('status', status));
  poller.on('tweets', (tweets) => broadcast('tweets', tweets));
  poller.on('alert', (alert) => broadcast('alert', alert));
  poller.on('stats', (stats) => broadcast('stats', stats));

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, 25000);
  heartbeat.unref();

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/state') {
      const engines = await listAvailableEngines({
        httpUrl: config.aiHttpUrl,
        httpModel: config.aiHttpModel,
        engine: config.aiEngine,
      });
      return json(res, 200, {
        config: { ...config, aiHttpKey: '', xAuthToken: '', xCt0: '' },
        aiHttpKeySet: Boolean(config.aiHttpKey),
        xCookieSet: Boolean(config.xAuthToken && config.xCt0),
        status: { ...poller.status },
        stats: store.getStats(),
        account: store.getMeta('account'),
        rules: getRuleInfo(),
        ai: { engines },
        ocr: ocrStatus(),
        serverTime: Date.now(),
      });
    }

    if (route === 'GET /api/tweets') {
      const params = url.searchParams;
      const result = store.getTweets({
        limit: clamp(Number(params.get('limit')) || 60, 1, 500),
        offset: Math.max(0, Number(params.get('offset')) || 0),
        resetOnly: params.get('resetOnly') === '1',
        q: (params.get('q') ?? '').slice(0, 100),
        hours: Math.max(0, Number(params.get('hours')) || 0),
      });
      return json(res, 200, { ...result, serverTime: Date.now() });
    }

    if (route === 'GET /api/alerts') {
      const limit = clamp(Number(url.searchParams.get('limit')) || 50, 1, 200);
      return json(res, 200, { items: store.getAlerts(limit) });
    }

    if (route === 'GET /api/img') {
      const raw = url.searchParams.get('u') ?? '';
      let target;
      try {
        target = new URL(raw);
      } catch {
        return json(res, 400, { ok: false, error: 'bad url' });
      }
      if (!IMG_HOSTS.has(target.hostname)) return json(res, 403, { ok: false, error: 'host not allowed' });

      const ext = (path.extname(target.pathname) || '.jpg').slice(0, 5);
      const key = crypto.createHash('sha1').update(target.href).digest('hex');
      const cachePath = path.join(IMG_DIR, key + ext);

      try {
        const data = await fs.promises.readFile(cachePath);
        res.writeHead(200, {
          'content-type': MIME[ext] ?? 'image/jpeg',
          'cache-control': 'public, max-age=86400',
        });
        return res.end(data);
      } catch {
        // not cached yet
      }

      try {
        const upstream = await fetch(target.href, {
          headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://x.com/' },
          signal: AbortSignal.timeout(12000),
        });
        if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
        const buf = Buffer.from(await upstream.arrayBuffer());
        await fs.promises.mkdir(IMG_DIR, { recursive: true });
        await fs.promises.writeFile(cachePath, buf);
        res.writeHead(200, {
          'content-type': upstream.headers.get('content-type') ?? MIME[ext] ?? 'image/jpeg',
          'cache-control': 'public, max-age=86400',
        });
        return res.end(buf);
      } catch {
        res.writeHead(502);
        return res.end('image fetch failed');
      }
    }

    if (route === 'GET /api/export') {
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': 'attachment; filename="codex-reset-tweets.jsonl"',
      });
      for (const tweet of store.allTweets()) res.write(`${JSON.stringify(tweet)}\n`);
      return res.end();
    }

    if (route === 'GET /api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (route === 'POST /api/control') {
      const body = await readBody(req);
      if (body.action === 'start') {
        poller.start();
        return json(res, 200, { ok: true, status: { ...poller.status } });
      }
      if (body.action === 'stop') {
        poller.stop();
        return json(res, 200, { ok: true, status: { ...poller.status } });
      }
      if (body.action === 'poll') {
        const result = await poller.pollOnce('manual');
        return json(res, 200, { ok: result.ok !== false, result, status: { ...poller.status } });
      }
      return json(res, 400, { ok: false, error: '未知 action' });
    }

    if (route === 'POST /api/config') {
      const body = await readBody(req);
      const patch = sanitizeConfigPatch(body);
      Object.assign(config, saveConfig(patch));
      poller.setConfig(config);
      broadcast('config', config);
      return json(res, 200, { ok: true, config });
    }

    if (route === 'POST /api/rescan') {
      const tweets = store.allTweets();
      let alerts = 0;
      for (const tweet of tweets) {
        const detection = detectReset(tweet.text, {
          extraKeywords: config.extraKeywords,
          threshold: config.resetThreshold,
        });
        const finalIsReset = tweet.aiVerdict ?? detection.isReset;
        store.setDetection(tweet.id, detection, finalIsReset);
        if (finalIsReset) alerts += 1;
      }
      const notified = await poller.notifyPendingFresh();
      broadcast('stats', store.getStats());
      return json(res, 200, { ok: true, scanned: tweets.length, alerts, notified });
    }

    if (route === 'POST /api/simulate') {
      const body = await readBody(req);
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { ok: false, error: '缺少 text' });
      const account = store.getMeta('account') ?? {};
      const now = Date.now();
      const tweet = {
        id: `sim-${now}`,
        createdAt: new Date(now).toISOString(),
        createdTs: now,
        text,
        favoriteCount: 0,
        replyCount: 0,
        retweetCount: 0,
        quoteCount: 0,
        permalink: '',
        avatar: account.avatar ?? '',
        authorName: account.name ?? 'Tibo Sottiaux',
        authorHandle: account.handle ?? config.handle,
        lang: 'en',
        media: [],
      };
      const result = await poller.ingest([tweet], { source: 'simulate' });
      const stored = store.getTweet(tweet.id);
      broadcast('stats', store.getStats());
      return json(res, 200, {
        ok: true,
        inserted: result.inserted.length,
        notified: result.notified,
        detection: { isReset: stored.isReset, score: stored.resetScore, signals: stored.resetSignals },
      });
    }

    if (route === 'POST /api/test-notify') {
      await notifyMac({
        title: 'Codex 限额即将重置',
        subtitle: '通知通道测试',
        message: 'Good news: rate limits have been reset for everyone. Enjoy!',
        sound: config.notifySound,
      }).catch((err) => err.message);
      return json(res, 200, { ok: true });
    }

    if (route === 'POST /api/test-ai') {
      const body = await readBody(req);
      const text = String(body.text ?? 'Reset all propagated. Sweet dreams.').trim();
      const verdict = await judgeTweet(text, aiOptionsFromConfig(config));
      if (verdict.error) return json(res, 200, { ok: false, error: verdict.error });
      return json(res, 200, { ok: true, text, verdict });
    }

    if (route === 'POST /api/translate') {
      const body = await readBody(req);
      const id = String(body.id ?? '');
      const tweet = store.getTweet(id);
      if (!tweet) return json(res, 404, { ok: false, error: '推文不存在' });
      if (tweet.translation) {
        return json(res, 200, { ok: true, translation: tweet.translation, cached: true });
      }
      const result = await translateText(tweet.text, aiOptionsFromConfig(config));
      if (result.error) return json(res, 200, { ok: false, error: result.error });
      store.setTranslation(id, result.text);
      return json(res, 200, { ok: true, translation: result.text, engine: result.engine });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const filePath = path.resolve(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('not found');
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { ok: false, error: err.message });
    }
  });

  server.on('close', () => clearInterval(heartbeat));
  return server;
}
