import fs from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

export function decodeEntities(text = '') {
  return String(text)
    .replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export function normalizeTweet(t) {
  const user = t.user ?? {};
  const created = new Date(t.created_at);
  const valid = !Number.isNaN(created.getTime());
  const media = (t.entities?.media ?? [])
    .map((m) => ({ type: m.type ?? 'photo', url: m.media_url_https ?? m.media_url ?? '' }))
    .filter((m) => m.url);

  return {
    id: String(t.id_str ?? t.id),
    createdAt: valid ? created.toISOString() : new Date().toISOString(),
    createdTs: valid ? created.getTime() : Date.now(),
    text: decodeEntities(t.full_text ?? t.text ?? ''),
    favoriteCount: t.favorite_count ?? 0,
    replyCount: t.reply_count ?? 0,
    retweetCount: t.retweet_count ?? 0,
    quoteCount: t.quote_count ?? 0,
    permalink: t.permalink
      ? `https://x.com${t.permalink}`
      : `https://x.com/${user.screen_name ?? 'i'}/status/${t.id_str}`,
    avatar: user.profile_image_url_https ?? '',
    authorName: user.name ?? '',
    authorHandle: user.screen_name ?? '',
    lang: t.lang ?? '',
    media,
  };
}

export function parseTimelineHtml(html) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error('页面结构变化：未找到 __NEXT_DATA__（X 可能调整了接口）');

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('页面结构变化：__NEXT_DATA__ 不是合法 JSON');
  }

  const entries = data?.props?.pageProps?.timeline?.entries;
  if (!Array.isArray(entries)) throw new Error('页面结构变化：timeline.entries 缺失');

  const seen = new Set();
  const tweets = [];
  for (const entry of entries) {
    const raw = entry?.content?.tweet;
    if (!raw?.id_str && !raw?.id) continue;
    const tweet = normalizeTweet(raw);
    if (seen.has(tweet.id)) continue;
    seen.add(tweet.id);
    tweets.push(tweet);
  }

  tweets.sort((a, b) => a.createdTs - b.createdTs);
  return tweets;
}

export async function fetchTimeline(handle) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(
    handle,
  )}?ts=${Date.now()}`;

  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(20000),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    const err = new Error(`HTTP 429（触发限流${retryAfter ? `，${retryAfter}s 后重试` : ''}）`);
    err.retryAfter = retryAfter;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  return parseTimelineHtml(await res.text());
}

function stripHtml(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).trim();
}

function rssTag(block, name) {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? stripHtml(match[1]) : '';
}

function rssLink(block) {
  const plain = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (plain && stripHtml(plain[1])) return stripHtml(plain[1]);
  const href = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
  return href ? href[1] : '';
}

export function parseRssFeed(xml) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  const tweets = [];

  for (const block of blocks) {
    const link = rssLink(block);
    const text = stripHtml(
      rssTag(block, 'description') || rssTag(block, 'content:encoded') || rssTag(block, 'summary') || rssTag(block, 'content'),
    );
    const dateRaw = rssTag(block, 'pubDate') || rssTag(block, 'published') || rssTag(block, 'updated');
    const created = new Date(dateRaw);
    const valid = !Number.isNaN(created.getTime());
    const idMatch = link.match(/status\/(\d+)/) || rssTag(block, 'guid').match(/(\d{10,})/);
    const id = idMatch ? idMatch[1] : `rss-${Buffer.from(text.slice(0, 40) + dateRaw).toString('base64url').slice(0, 20)}`;
    const authorMatch = link.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/);

    if (!text) continue;
    tweets.push({
      id,
      createdAt: valid ? created.toISOString() : new Date().toISOString(),
      createdTs: valid ? created.getTime() : Date.now(),
      text,
      favoriteCount: 0,
      replyCount: 0,
      retweetCount: 0,
      quoteCount: 0,
      permalink: link || `https://x.com`,
      avatar: '',
      authorName: '',
      authorHandle: authorMatch ? authorMatch[1] : '',
      lang: '',
      media: [],
    });
  }

  tweets.sort((a, b) => a.createdTs - b.createdTs);
  return tweets;
}

export async function fetchFromRss(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, text/xml, */*' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  return parseRssFeed(await res.text());
}

export function fixtureFetcher(filePath) {
  return async () => parseTimelineHtml(fs.readFileSync(filePath, 'utf8'));
}

/* ── 单推详情（比时间线接口新鲜，可精确抓取指定推文） ───────── */

export function normalizeTweetDetail(t) {
  const user = t.user ?? {};
  const created = new Date(t.created_at);
  const valid = !Number.isNaN(created.getTime());
  const media = (t.entities?.media ?? [])
    .map((m) => ({ type: m.type ?? 'photo', url: m.media_url_https ?? m.media_url ?? '' }))
    .filter((m) => m.url);

  return {
    id: String(t.id_str ?? t.id),
    createdAt: valid ? created.toISOString() : new Date().toISOString(),
    createdTs: valid ? created.getTime() : Date.now(),
    text: decodeEntities(t.text ?? t.full_text ?? ''),
    favoriteCount: t.favorite_count ?? 0,
    replyCount: t.reply_count ?? t.conversation_count ?? 0,
    retweetCount: t.retweet_count ?? 0,
    quoteCount: t.quote_count ?? 0,
    permalink: `https://x.com/${user.screen_name ?? 'i'}/status/${t.id_str ?? t.id}`,
    avatar: user.profile_image_url_https ?? '',
    authorName: user.name ?? '',
    authorHandle: user.screen_name ?? '',
    lang: t.lang ?? '',
    media,
  };
}

export function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export async function fetchTweetById(id) {
  const res = await fetch(
    `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=${syndicationToken(id)}`,
    {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) throw new Error(`单推 HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.id_str) throw new Error('单推空响应');
  return normalizeTweetDetail(data);
}

export async function fetchTweetWithRelated(id, handle) {
  const res = await fetch(
    `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=${syndicationToken(id)}`,
    {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) throw new Error(`单推 HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.id_str) throw new Error('单推空响应');

  const tweet = normalizeTweetDetail(data);
  const related = [];
  const target = String(handle).toLowerCase();
  const parent = data.parent;
  if (
    parent?.id_str &&
    String(data.in_reply_to_screen_name ?? '').toLowerCase() === target
  ) {
    related.push(normalizeTweetDetail({ ...parent, user: parent.user ?? data.user }));
  }
  return { tweet, related };
}

/* ── 公开主页抓 ID（免登录，本环境可拿实时数据） ────────── */

export function extractProfileIds(html, maxAgeDays = 30) {
  const ids = new Set();
  for (const match of html.matchAll(/rest_id:"(\d{15,20})"/g)) ids.add(match[1]);
  for (const match of html.matchAll(/status\/(\d{15,20})/g)) ids.add(match[1]);

  const now = Date.now();
  const cutoff = now - maxAgeDays * 24 * 3600 * 1000;
  return [...ids]
    .map((id) => ({ id, ts: Number((BigInt(id) >> 22n) + 1288834974657n) }))
    .filter((item) => item.ts > cutoff && item.ts < now + 3600 * 1000)
    .sort((a, b) => b.ts - a.ts)
    .map((item) => item.id);
}

export function extractProfileUserId(html) {
  const match = html.match(/__typename:"User",rest_id:"(\d{15,20})"/);
  return match ? match[1] : '';
}

export async function fetchProfile(handle) {
  const url = `https://x.com/${encodeURIComponent(handle)}?t=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`主页 HTTP ${res.status}`);
  const html = await res.text();
  return { tweetIds: extractProfileIds(html), userId: extractProfileUserId(html) };
}

export async function fetchProfileIds(handle) {
  return (await fetchProfile(handle)).tweetIds;
}

/* ── 搜索发现：时间线接口滞后 / 限流时，用搜索引擎找最新推文 ID ── */

export function extractStatusIds(text, handle) {
  const ids = new Set();
  const decoded = String(text).replace(/uddg=([^&"'\\]+)/g, (_, encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return '';
    }
  });
  const safe = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:x|twitter)\\.com/${safe}/status/(\\d{15,20})`, 'gi');
  for (const match of decoded.matchAll(re)) ids.add(match[1]);
  return [...ids].sort().reverse();
}

const DISCOVERY_QUERIES = [
  { build: (handle) => `site:x.com/${handle}/status`, variant: 'fresh' },
  { build: (handle) => `site:x.com/${handle}/status`, variant: null },
  { build: (handle) => `site:x.com/${handle}/status reset`, variant: 'fresh' },
  { build: (handle) => `site:x.com/${handle}/status reset`, variant: null },
];

const DISCOVERY_PROVIDERS = [
  {
    name: 'search.brave.com',
    url: (handle, query, variant) =>
      `https://search.brave.com/search?q=${encodeURIComponent(query)}${variant === 'fresh' ? '&tf=pd' : ''}`,
  },
  {
    name: 'html.duckduckgo.com',
    url: (handle, query, variant) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${variant === 'fresh' ? '&df=d' : ''}`,
  },
  {
    name: 'lite.duckduckgo.com',
    url: (handle, query, variant) =>
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}${variant === 'fresh' ? '&df=d' : ''}`,
  },
  {
    name: 'unrollnow.com',
    url: (handle) => `https://www.unrollnow.com/${encodeURIComponent(handle)}`,
  },
];

const providerState = new Map();
const PROVIDER_COOLDOWN_MS = 10 * 60 * 1000;

function getProviderState(name) {
  if (!providerState.has(name)) providerState.set(name, { cooldownUntil: 0, lastUsedAt: 0 });
  return providerState.get(name);
}

async function queryProviders(handle, query, variant) {
  const candidates = DISCOVERY_PROVIDERS.map((provider) => ({
    provider,
    state: getProviderState(provider.name),
  }))
    .filter(({ state }) => state.cooldownUntil <= Date.now())
    .sort((a, b) => a.state.lastUsedAt - b.state.lastUsedAt);

  let attempted = false;
  for (const { provider, state } of candidates) {
    attempted = true;
    try {
      const res = await fetch(provider.url(handle, query, variant), {
        headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });
      if (res.ok) {
        const found = extractStatusIds(await res.text(), handle);
        if (found.length) {
          state.cooldownUntil = 0;
          state.lastUsedAt = Date.now();
          return { ids: found, source: provider.name, attempted };
        }
      }
      state.cooldownUntil = Date.now() + PROVIDER_COOLDOWN_MS;
    } catch {
      state.cooldownUntil = Date.now() + PROVIDER_COOLDOWN_MS;
    }
  }
  return { ids: [], source: null, attempted };
}

let discoveryCursor = 0;

export async function discoverTweetIds(handle) {
  const entry = DISCOVERY_QUERIES[discoveryCursor % DISCOVERY_QUERIES.length];
  discoveryCursor += 1;
  const { ids, source, attempted } = await queryProviders(handle, entry.build(handle), entry.variant);
  return { ids, source, attempted };
}

