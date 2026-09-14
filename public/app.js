const $ = (sel, root = document) => root.querySelector(sel);

const ICONS = {
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z"/></svg>',
  heart:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6.3a5 5 0 1 1 7.5 6.3Z"/></svg>',
  reply:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.5-2.7A8.4 8.4 0 0 1 5 12a8 8 0 0 1 8-8 8 8 0 0 1 8 8Z"/></svg>',
  rt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10.5 13.5"/><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"/></svg>',
  radar:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.6" opacity=".4"/><circle cx="12" cy="12" r="4.6" opacity=".7"/><path d="M12 12 18.6 7.4"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r="0.6" fill="currentColor" stroke="none"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.7" fill="currentColor" stroke="none"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.4" height="14" rx="1.4"/><rect x="13.6" y="5" width="3.4" height="14" rx="1.4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.8c0-1 1.1-1.6 2-1L19 11a1.2 1.2 0 0 1 0 2L10 19.2c-.9.6-2 0-2-1V5.8Z"/></svg>',
};

const state = {
  config: null,
  status: null,
  stats: null,
  account: null,
  rules: null,
  tweets: [],
  tweetIds: new Set(),
  tweetsTotal: 0,
  alerts: [],
  pageSize: 60,
  filter: 'all',
  q: '',
  skew: 0,
};

/* ── utils ─────────────────────────────────────────────── */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fmtAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 45_000) return '刚刚';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function fmtNum(n) {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function proxyImg(url) {
  if (!url) return '';
  if (Platform.kind === 'tauri') return url;
  if (!/^https?:\/\//.test(url)) return url;
  return `/api/img?u=${encodeURIComponent(url)}`;
}

function highlight(text, matches) {
  let html = esc(text);
  const parts = matches
    .flatMap((m) => String(m).split(' … '))
    .map((m) => m.trim())
    .filter((m) => m.length > 1);
  for (const part of new Set(parts)) {
    const re = new RegExp(escRe(esc(part)), 'gi');
    html = html.replace(re, (x) => `<mark>${x}</mark>`);
  }
  return html;
}

function positiveSignals(tweet) {
  return (tweet.resetSignals ?? []).filter((s) => s.weight > 0);
}

/* ── 状态渲染 ──────────────────────────────────────────── */

const PHASES = {
  idle: ['live', '监控中'],
  checking: ['checking', '正在抓取'],
  ok: ['live', '监控中'],
  error: ['error', '抓取失败，自动重试'],
  paused: ['paused', '已暂停'],
};

function renderStatus() {
  const chip = $('#statusChip');
  const status = state.status ?? {};
  const throttled = /429|限流/.test(status.lastError ?? '');
  const [cls, label] =
    status.phase === 'error' && throttled
      ? ['warn', '数据源限流，自动重试']
      : PHASES[status.phase] ?? PHASES.idle;
  chip.className = `status-chip ${cls}`;
  $('#statusText').textContent = label;
  if (status.phase === 'error') chip.title = `抓取失败，自动重试：${status.lastError ?? ''}`;
  else if (status.lastSource) chip.title = `数据源：${status.lastSource}`;
  else chip.removeAttribute('title');
  tick();
}

const SOURCE_LABELS = { syndication: '时间线', profile: '公开页', graphql: 'Cookie接口', rss: 'RSS' };

function sourceLabel(source) {
  if (!source) return '';
  return source
    .split('+')
    .map((part) => {
      if (SOURCE_LABELS[part]) return SOURCE_LABELS[part];
      if (/brave|duckduckgo|unrollnow/.test(part)) return '搜索';
      return part;
    })
    .join('+');
}

function tick() {
  const status = state.status ?? {};
  const countdown = $('#countdown');
  const statNext = $('#statNext');
  const now = Date.now() + state.skew;

  let text = '—';
  if (status.checking) text = '抓取中…';
  else if (!status.running) text = '已暂停';
  else if (status.nextCheckAt) {
    const sec = Math.max(0, Math.round((status.nextCheckAt - now) / 1000));
    text = sec >= 60 ? `${Math.ceil(sec / 60)} 分钟后` : `${sec}s 后`;
  }
  countdown.textContent = text;
  if (statNext) statNext.textContent = text;
  const sub = $('#statNextSub');
  if (sub && state.config) sub.textContent = `每 ${state.config.intervalSec}s`;
  const lastSub = $('#statLastSub');
  if (lastSub && status.lastCheckAt) {
    const time = fmtTime(status.lastCheckAt).slice(11);
    const source = sourceLabel(status.lastSource);
    lastSub.textContent = source ? `${time} · ${source}` : time;
  }
  const statLast = $('#statLast');
  if (statLast) statLast.textContent = status.lastCheckAt ? fmtAgo(status.lastCheckAt) : '—';
}

function freshAlert() {
  const hours = state.config?.freshHours ?? 6;
  const cutoff = Date.now() - hours * 3600_000;
  return state.alerts.find((a) => a.createdTs >= cutoff) ?? null;
}

function renderHero() {
  const hero = $('#hero');
  const status = state.status ?? {};

  if (state.alerts.length === 0 && status.running === false && state.config) {
    hero.innerHTML = `
      <section class="hero hero-paused">
        <div>
          <h2>监控已暂停</h2>
          <p>轮询已停止，不会抓取也不会通知。</p>
        </div>
        <button class="btn primary" data-action="resume">${ICONS.play} 恢复监控</button>
      </section>`;
    return;
  }

  const alert = freshAlert();
  if (alert) {
    const signals = positiveSignals(alert);
    const hours = state.config?.freshHours ?? 6;
    const hasAi = alert.aiVerdict !== null && alert.aiVerdict !== undefined;
    hero.innerHTML = `
      <section class="hero hero-fresh">
        <div class="hero-glow"></div>
        <div class="hero-top">
          <span class="badge ok"><span class="pulse-dot"></span>检测到重置公告</span>
          <span class="hero-time">${alert.source === 'simulate' ? '模拟 · ' : ''}${esc(fmtAgo(alert.createdTs))} · ${hasAi ? `AI 判定${alert.aiConfidence != null ? ` ${Math.round(alert.aiConfidence * 100)}%` : ''}` : `得分 ${alert.resetScore}`}</span>
        </div>
        <h2 class="hero-title">Codex 限额已重置，尽快使用</h2>
        <p class="hero-text">${highlight(alert.text, signals.map((s) => s.match))}</p>
        <div class="hero-signals">
          ${hasAi ? `<span class="signal pos">AI ${esc(alert.aiEngine || '')}：${esc(alert.aiReason || '确认公告')}</span>` : ''}
          ${signals.map((s) => `<span class="signal pos">+${s.weight} ${esc(s.label)}</span>`).join('')}
        </div>
        <div class="hero-actions">
          <a class="btn primary" href="${esc(alert.permalink || `https://x.com/${state.config?.handle ?? ''}`)}" target="_blank" rel="noreferrer">${ICONS.ext} 在 X 上查看</a>
          <button class="btn ghost" data-copy-id="${esc(alert.id)}">复制推文</button>
        </div>
        <p class="hero-foot">发布于 ${esc(fmtTime(alert.createdTs))} · 新鲜窗口 ${hours}h 内的公告会触发系统通知</p>
      </section>`;
    return;
  }

  const last = state.alerts[0];
  hero.innerHTML = `
    <section class="hero hero-idle">
      <div class="hero-idle-icon">${ICONS.radar}</div>
      <div style="min-width:0">
        <h2>最近 ${state.config?.freshHours ?? 6} 小时未检测到重置公告</h2>
        <p>安静等待中。一旦 @${esc(state.config?.handle ?? '')} 发布重置消息，你会立刻收到系统通知。</p>
        <p class="hero-foot" style="border:none;padding-top:6px;margin-top:6px">${
          last
            ? `上次重置公告：${esc(fmtAgo(last.createdTs))} · ${esc(fmtTime(last.createdTs))}`
            : '数据库中还没有检测到任何重置公告'
        }</p>
      </div>
    </section>`;
}

function renderStats() {
  const stats = state.stats;
  if (!stats) return;
  const hours = state.config?.freshHours ?? 6;
  const cutoff = Date.now() - hours * 3600_000;
  const freshCount = state.alerts.filter((a) => a.createdTs >= cutoff).length;

  $('#statTotal').textContent = stats.total;
  $('#statTotalSub').textContent = stats.todayCount ? `今日 +${stats.todayCount}` : '';
  $('#statResets').textContent = stats.resetCount;
  $('#statResetsSub').textContent = freshCount
    ? `${hours}h 内 ${freshCount} 条`
    : stats.lastAlertTs
      ? `上次 ${fmtAgo(stats.lastAlertTs)}`
      : '暂无';
  tick();
}

/* ── 时间线 ────────────────────────────────────────────── */

function tweetHTML(tweet) {
  const isReset = tweet.isReset;
  const signals = positiveSignals(tweet);
  const media = (tweet.media ?? []).slice(0, 4);
  const hasAi = tweet.aiVerdict !== null && tweet.aiVerdict !== undefined;
  const aiBadge = hasAi
    ? `<span class="pill ai ${tweet.aiVerdict ? 'ok' : 'no'}" title="AI 判定：${esc(tweet.aiReason || '')}（${esc(tweet.aiEngine || '')}）">AI ${tweet.aiVerdict ? '✓ 公告' : '✗ 非公告'}</span>`
    : '';
  const aiLine =
    hasAi && tweet.aiReason
      ? `<div class="tweet-ai">AI 判定：${esc(tweet.aiReason)}${tweet.aiConfidence != null ? ` · 置信 ${Math.round(tweet.aiConfidence * 100)}%` : ''} <span class="ai-engine">${esc(tweet.aiEngine || '')}</span></div>`
      : '';
  const ocrLine = tweet.ocrText
    ? `<div class="tweet-ai">图片文字：${esc(tweet.ocrText.replace(/\s+/g, ' ').slice(0, 160))}${tweet.ocrText.length > 160 ? '…' : ''} <span class="ai-engine">ocr</span></div>`
    : '';
  return `
    <article class="tweet ${isReset ? 'is-reset' : ''}">
      ${tweet.avatar ? `<img class="avatar" data-fallback="avatar" data-initial="${esc((tweet.authorName || tweet.authorHandle || 'T').slice(0, 1).toUpperCase())}" src="${esc(proxyImg(tweet.avatar))}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="avatar avatar-fallback">T</div>'}
      <div class="tweet-body">
        <header class="tweet-head">
          <span class="tweet-name">${esc(tweet.authorName || 'Tibo Sottiaux')}</span>
          <span class="tweet-handle">@${esc(tweet.authorHandle || state.config?.handle || '')}</span>
          <span class="tweet-dot">·</span>
          <time class="tweet-time" title="${esc(fmtTime(tweet.createdTs))}">${esc(fmtAgo(tweet.createdTs))}</time>
          ${isReset ? `<span class="pill reset">${ICONS.zap} 重置信号 +${tweet.resetScore}</span>` : ''}
          ${aiBadge}
          ${tweet.source === 'simulate' ? '<span class="pill sim">模拟</span>' : ''}
        </header>
        <div class="tweet-text">${highlight(tweet.text, signals.map((s) => s.match))}</div>
        ${aiLine}
        ${ocrLine}
        ${
          media.length
            ? `<div class="media-grid n${media.length}">${media
                .map(
                  (m) =>
                    `<a href="${esc(tweet.permalink || m.url)}" target="_blank" rel="noreferrer"><img data-fallback="media" src="${esc(proxyImg(m.url))}" alt="" loading="lazy" referrerpolicy="no-referrer" /></a>`,
                )
                .join('')}</div>`
            : ''
        }
        <footer class="tweet-foot">
          <span class="metric">${ICONS.heart}${fmtNum(tweet.favoriteCount)}</span>
          <span class="metric">${ICONS.reply}${fmtNum(tweet.replyCount)}</span>
          <span class="metric">${ICONS.rt}${fmtNum(tweet.retweetCount)}</span>
          <a class="tweet-link" href="${esc(tweet.permalink || `https://x.com/${state.config?.handle ?? ''}`)}" target="_blank" rel="noreferrer">在 X 上查看 ${ICONS.ext}</a>
        </footer>
      </div>
    </article>`;
}

function renderFeed() {
  const feed = $('#feed');
  $('#feedCount').textContent = `${state.tweets.length} / ${state.tweetsTotal}`;
  if (!state.tweets.length) {
    feed.innerHTML = `
      <div class="empty">
        ${ICONS.radar}
        <p>没有匹配的推文</p>
      </div>`;
  } else {
    feed.innerHTML = state.tweets.map(tweetHTML).join('');
  }
  $('#loadMore').hidden = state.tweets.length >= state.tweetsTotal;
}

async function loadTweets(reset) {
  const data = await Platform.getTweets({
    limit: state.pageSize,
    offset: reset ? 0 : state.tweets.length,
    resetOnly: state.filter === 'reset',
    q: state.q,
  });
  if (reset) {
    state.tweets = data.items;
    state.tweetIds = new Set(data.items.map((t) => t.id));
  } else {
    for (const tweet of data.items) {
      if (!state.tweetIds.has(tweet.id)) {
        state.tweets.push(tweet);
        state.tweetIds.add(tweet.id);
      }
    }
  }
  state.tweetsTotal = data.total;
  renderFeed();
}

/* ── 警报历史 ──────────────────────────────────────────── */

function renderAlerts() {
  const box = $('#alerts');
  $('#alertsNote').textContent = state.alerts.length ? `${state.alerts.length} 条` : '';
  if (!state.alerts.length) {
    box.innerHTML = `
      <div class="empty" style="padding:34px 20px">
        ${ICONS.bell}
        <p>还没有检测到重置公告</p>
      </div>`;
    return;
  }
  const fresh = freshAlert();
  box.innerHTML = state.alerts
    .map(
      (a) => `
      <a class="alert-item" href="${esc(a.permalink || '#')}" ${a.permalink ? 'target="_blank" rel="noreferrer"' : ''}>
        <div class="alert-time">
          <span>${esc(fmtAgo(a.createdTs))}${a.id === fresh?.id ? ' · <span style="color:var(--ok)">新鲜</span>' : ''}</span>
          <span class="score">+${a.resetScore}</span>
        </div>
        <div class="alert-text">${esc(a.text)}</div>
      </a>`,
    )
    .join('');
}

async function loadAlerts() {
  const data = await Platform.getAlerts(50);
  state.alerts = data.items;
  renderAlerts();
  renderHero();
  renderStats();
}

/* ── 设置 ──────────────────────────────────────────────── */

const INTERVALS = [
  [600, '10m'],
  [900, '15m'],
  [1800, '30m'],
  [3600, '60m'],
];

/** 已配置的密钥不回显真实值，用一排掩码占位（密码框会渲染成圆点） */
const MASK = 'maskedsecretmaskedsecret';

function renderSettings() {
  const config = state.config;
  const running = state.status?.running;

  const options = [...INTERVALS];
  if (!options.some(([sec]) => sec === config.intervalSec)) {
    options.push([config.intervalSec, `${config.intervalSec}s`]);
    options.sort((a, b) => a[0] - b[0]);
  }

  $('#settings').innerHTML = `
    <div class="setting setting-row">
      <div>
        <div class="setting-label">启用轮询</div>
        <div class="setting-hint">暂停后不再抓取，也不会通知</div>
      </div>
      <button class="switch" data-field="running" aria-checked="${running ? 'true' : 'false'}" aria-label="启用轮询"></button>
    </div>

    <div class="setting">
      <div class="setting-label">轮询间隔<span class="setting-hint">多久向 X 抓取一次新推文（越短越容易被限流）</span></div>
      <div class="segmented" data-field="intervalSec">
        ${options
          .map(
            ([sec, label]) =>
              `<button data-value="${sec}" class="${sec === config.intervalSec ? 'active' : ''}">${label}</button>`,
          )
          .join('')}
      </div>
    </div>

    <div class="setting setting-row">
      <div>
        <div class="setting-label">系统通知</div>
        <div class="setting-hint">检测到重置公告时发送 macOS 通知</div>
      </div>
      <button class="switch" data-field="notify" aria-checked="${config.notify ? 'true' : 'false'}" aria-label="系统通知"></button>
    </div>

    <div class="setting setting-row">
      <div>
        <div class="setting-label">通知声音</div>
        <div class="setting-hint">${esc(config.notifySound || '关闭')}</div>
      </div>
      <button class="switch" data-field="soundOn" aria-checked="${config.notifySound ? 'true' : 'false'}" aria-label="通知声音"></button>
    </div>

    <div class="input-row">
      <div>
        <div class="setting-label">新鲜窗口（小时）</div>
        <input class="input mono" id="freshHours" type="number" min="0" max="168" value="${config.freshHours}" />
      </div>
      <div>
        <div class="setting-label">触发阈值（分）</div>
        <input class="input mono" id="resetThreshold" type="number" min="1" max="10" value="${config.resetThreshold}" />
      </div>
    </div>

    <div class="setting">
      <div class="setting-label">自定义关键词<span class="setting-hint">逗号分隔，命中即 +3 分</span></div>
      <input class="input" id="extraKeywords" value="${esc((config.extraKeywords ?? []).join(', '))}" placeholder="例如：refill wave, extra usage" />
    </div>

    <div class="setting">
      <div class="setting-label">RSS 备用源<span class="setting-hint">X 接口限流时自动切换；可填 RSSHub / 自建 Nitter 的 RSS 地址</span></div>
      <input class="input mono" id="rssUrl" value="${esc(config.rssUrl ?? '')}" placeholder="https://example.com/twitter/user/thsottiaux" />
    </div>

    <div class="setting setting-row">
      <div>
        <div class="setting-label">搜索发现</div>
        <div class="setting-hint">时间线接口滞后 / 限流时，用搜索引擎发现最新推文</div>
      </div>
      <button class="switch" data-field="searchDiscovery" aria-checked="${config.searchDiscovery !== false ? 'true' : 'false'}" aria-label="搜索发现"></button>
    </div>

    <div class="setting setting-row">
      <div>
        <div class="setting-label">AI 判定</div>
        <div class="setting-hint">候选推文由 AI 判断，不可用时退回规则引擎</div>
      </div>
      <button class="switch" data-field="aiJudge" aria-checked="${config.aiJudge !== false ? 'true' : 'false'}" aria-label="AI 判定"></button>
    </div>

    <div class="setting">
      <div class="setting-label">AI 引擎<span class="setting-hint">${
        state.ai?.engines?.length
          ? `已就绪：${state.ai.engines.join(' → ')}`
          : '未检测到可用引擎，当前使用规则引擎'
      }</span></div>
      <select class="input" id="aiEngine">
        <option value="auto" ${config.aiEngine === 'auto' ? 'selected' : ''}>自动（HTTP → claude → codex → ollama）</option>
        <option value="http" ${config.aiEngine === 'http' ? 'selected' : ''}>HTTP 接口（OpenAI / Anthropic 兼容）</option>
        <option value="claude" ${config.aiEngine === 'claude' ? 'selected' : ''}>claude CLI</option>
        <option value="codex" ${config.aiEngine === 'codex' ? 'selected' : ''}>codex CLI</option>
        <option value="ollama" ${config.aiEngine === 'ollama' ? 'selected' : ''}>ollama 本地模型</option>
      </select>
    </div>

    <div class="setting">
      <div class="setting-label">HTTP 接口地址<span class="setting-hint">OpenAI 兼容端点；本地服务（LM Studio / one-api）可留空 Key</span></div>
      <input class="input mono" id="aiHttpUrl" value="${esc(config.aiHttpUrl ?? '')}" placeholder="https://api.openai.com/v1/chat/completions" />
    </div>

    <div class="input-row">
      <div>
        <div class="setting-label">模型</div>
        <input class="input mono" id="aiHttpModel" value="${esc(config.aiHttpModel ?? '')}" placeholder="gpt-4o-mini / qwen-plus" />
      </div>
      <div>
        <div class="setting-label">协议</div>
        <select class="input" id="aiHttpFormat">
          <option value="openai" ${config.aiHttpFormat !== 'anthropic' ? 'selected' : ''}>OpenAI 兼容</option>
          <option value="anthropic" ${config.aiHttpFormat === 'anthropic' ? 'selected' : ''}>Anthropic</option>
        </select>
      </div>
    </div>

    <div class="setting">
      <div class="setting-label">API Key<span class="setting-hint">${state.aiHttpKeySet ? '已配置 · 留空则保持不变' : '仅保存在本机 config.json（权限 600）'}</span></div>
      <input class="input mono" id="aiHttpKey" type="password" value="${state.aiHttpKeySet ? MASK : ''}" data-masked="${state.aiHttpKeySet ? 'true' : 'false'}" placeholder="sk-…" autocomplete="off" />
    </div>

    <div class="divider"></div>

    <div class="setting">
      <div class="setting-label">X 登录 Cookie<span class="setting-hint">${
        state.xCookieSet
          ? '已配置 · 用浏览器 Cookie 走 X 内部接口，数据最全最实时'
          : '两种方式：应用内登录（邮箱/手机号），或从浏览器导入'
      }</span></div>
      ${
        Platform.kind === 'tauri'
          ? '<button class="btn primary" data-action="x-login" style="margin-bottom:8px">登录 X 自动获取</button>'
          : ''
      }
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button class="btn ghost" data-action="paste-cookie">从剪贴板导入</button>
      </div>
      <input class="input mono" id="xAuthToken" type="password" value="${state.xCookieSet ? MASK : ''}" data-masked="${state.xCookieSet ? 'true' : 'false'}" placeholder="auth_token（整段粘贴 cURL 也可，会自动拆分）" autocomplete="off" />
      <input class="input mono" id="xCt0" type="password" value="${state.xCookieSet ? MASK : ''}" data-masked="${state.xCookieSet ? 'true' : 'false'}" placeholder="ct0" autocomplete="off" style="margin-top:6px" />
      <div class="setting-hint" id="cookieHint" style="margin-top:6px"></div>
    </div>

    <div class="setting-actions">
      <button class="btn ghost" data-action="test-ai">测试 AI 判定</button>
      <span class="save-state" id="aiTestResult" style="opacity:1"></span>
    </div>

    <div class="setting setting-row">
      <div>
        <div class="setting-label">图片 OCR</div>
        <div class="setting-hint">${
          state.ocr?.available === false
            ? '当前系统不支持 OCR（仅 macOS）'
            : '对截图类公告做本地文字识别（macOS Vision），仅处理近期带图推文'
        }</div>
      </div>
      <button class="switch" data-field="ocrEnabled" aria-checked="${config.ocrEnabled !== false ? 'true' : 'false'}" aria-label="图片 OCR"></button>
    </div>

    <div class="setting">
      <div class="setting-label">发现间隔（分钟）<span class="setting-hint">搜索源更稀缺，建议 10 分钟以上</span></div>
      <input class="input mono" id="discoveryInterval" type="number" min="5" max="60" value="${Math.round((config.discoveryIntervalSec ?? 600) / 60)}" />
    </div>

    <div class="setting-actions">
      <button class="btn primary" data-action="save-settings">保存设置</button>
      <span class="save-state" id="saveState">已保存</span>
    </div>

    ${
      Platform.canAutostart
        ? `
    <div class="setting setting-row">
      <div>
        <div class="setting-label">开机自启</div>
        <div class="setting-hint">登录后自动在后台运行；关闭窗口不退出，从菜单栏图标唤起</div>
      </div>
      <button class="switch" data-field="autostart" aria-checked="${config.autostart ? 'true' : 'false'}" aria-label="开机自启"></button>
    </div>`
        : ''
    }

    <div class="divider"></div>

    <div class="setting">
      <div class="setting-label">操作</div>
      <div class="actions-grid">
        <button class="btn ghost" data-action="simulate">模拟重置公告</button>
        <button class="btn ghost" data-action="test-notify">测试通知</button>
        <button class="btn ghost" data-action="rescan">重新扫描</button>
        <button class="btn ghost" data-action="export">导出数据</button>
      </div>
    </div>`;
}

/** 从 cURL / Cookie 字符串 / 请求头里提取 X 登录态（免去逐个找值） */
function parseXTokens(input) {
  const text = String(input ?? '');
  const find = (name) => {
    const match = text.match(new RegExp(`${name}=([^;'"\\s\\\\]+)`, 'i'));
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  };
  return { authToken: find('auth_token'), ct0: find('ct0') };
}

function collectSettings() {
  const settings = $('#settings');
  const intervalBtn = $('.segmented[data-field="intervalSec"] button.active', settings);
  const get = (field) => $(`.switch[data-field="${field}"]`, settings)?.getAttribute('aria-checked') === 'true';
  const patch = {
    intervalSec: Number(intervalBtn?.dataset.value) || state.config.intervalSec,
    notify: get('notify'),
    notifySound: get('soundOn') ? state.config.notifySound || 'Glass' : '',
    freshHours: Number($('#freshHours').value) || 0,
    resetThreshold: Number($('#resetThreshold').value) || 3,
    extraKeywords: $('#extraKeywords')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    rssUrl: $('#rssUrl').value.trim(),
    searchDiscovery: $('.switch[data-field="searchDiscovery"]', settings)
      ?.getAttribute('aria-checked') === 'true',
    discoveryIntervalSec: Math.max(5, Math.min(60, Number($('#discoveryInterval').value) || 10)) * 60,
    aiJudge: $('.switch[data-field="aiJudge"]', settings)?.getAttribute('aria-checked') === 'true',
    ocrEnabled: $('.switch[data-field="ocrEnabled"]', settings)?.getAttribute('aria-checked') === 'true',
    aiEngine: $('#aiEngine')?.value || 'auto',
    aiHttpUrl: $('#aiHttpUrl')?.value.trim() ?? '',
    aiHttpModel: $('#aiHttpModel')?.value.trim() ?? '',
    aiHttpFormat: $('#aiHttpFormat')?.value || 'openai',
  };
  const key = $('#aiHttpKey')?.value?.trim();
  if (key && $('#aiHttpKey').dataset.masked !== 'true') patch.aiHttpKey = key;
  const authInput = $('#xAuthToken');
  if (authInput && authInput.dataset.masked !== 'true' && authInput.value.trim()) {
    patch.xAuthToken = authInput.value.trim();
  }
  const ct0Input = $('#xCt0');
  if (ct0Input && ct0Input.dataset.masked !== 'true' && ct0Input.value.trim()) {
    patch.xCt0 = ct0Input.value.trim();
  }
  return patch;
}

async function saveSettings() {
  const patch = collectSettings();
  const data = await Platform.updateConfig(patch);
  state.config = data.config;
  renderSettings();
  await loadAlerts();
  const saveState = $('#saveState');
  saveState.classList.add('show');
  setTimeout(() => saveState.classList.remove('show'), 1800);
  showToast({ tone: 'info', title: '设置已保存', text: `轮询间隔 ${data.config.intervalSec}s · 阈值 ${data.config.resetThreshold} 分` });
}

function renderRules() {
  const rules = state.rules;
  if (!rules) return;
  $('#rulesView').innerHTML = `
    <div class="rule-threshold">阈值 ≥ ${state.config?.resetThreshold ?? 3} 分触发警报</div>
    <ul class="rule-list">
      ${rules.positive.map((r) => `<li><span class="weight pos">+${r.weight}</span>${esc(r.label)}</li>`).join('')}
      ${rules.negative.map((r) => `<li><span class="weight neg">${r.weight}</span>${esc(r.label)}</li>`).join('')}
    </ul>
    <div class="rule-note">负向规则会扣分，避免把 “git reset”、“重置密码” 这类推文误报成限额重置。调整阈值或添加关键词后，可点 “重新扫描” 立即重算全部历史推文。</div>`;
}

/* ── Toast ─────────────────────────────────────────────── */

function showToast({ tone = 'info', title, text = '', action, actionHref, timeout }) {
  const box = $('#toasts');
  const toast = document.createElement('div');
  toast.className = `toast tone-${tone}`;
  const icon = tone === 'alert' ? ICONS.zap : tone === 'error' ? ICONS.alert : ICONS.check;
  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">
      <div class="toast-title">${esc(title)}</div>
      ${text ? `<div class="toast-text">${esc(text)}</div>` : ''}
    </div>
    ${action ? `<a class="toast-action" href="${esc(actionHref || '#')}" target="_blank" rel="noreferrer">${esc(action)}</a>` : ''}
    <button class="toast-close" aria-label="关闭">×</button>`;

  const dismiss = () => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 240);
  };
  toast.querySelector('.toast-close').addEventListener('click', dismiss);
  box.append(toast);
  setTimeout(dismiss, timeout ?? (tone === 'alert' ? 20000 : 5000));
}

/* ── 动作 ──────────────────────────────────────────────── */

async function pollNow() {
  const btn = $('#pollBtn');
  btn.disabled = true;
  btn.querySelector('svg').classList.add('spin');
  try {
    const data = await Platform.control('poll');
    if (data.result?.skipped) {
      showToast({ tone: 'info', title: '正在抓取中', text: '稍等片刻，结果会自动刷新。' });
    } else if (data.result?.ok) {
      showToast({
        tone: 'info',
        title: '抓取完成',
        text: `共 ${data.result.fetched} 条推文，新增 ${data.result.inserted} 条，警报 ${data.result.alerts} 条`,
      });
      await loadTweets(true);
    } else {
      showToast({ tone: 'error', title: '抓取失败', text: data.result?.error ?? '未知错误' });
    }
    if (data.status) {
      state.status = data.status;
      renderStatus();
      renderHero();
    }
  } catch (err) {
    showToast({ tone: 'error', title: '请求失败', text: err.message });
  } finally {
    btn.disabled = false;
    btn.querySelector('svg').classList.remove('spin');
  }
}

const SIMULATIONS = [
  "We've reset all Codex usage limits — go ship something great!",
  'Good news: rate limits have been reset for everyone. Enjoy the weekend.',
  'Resetting the 5h limits now, sorry for the wait!',
];

async function simulate() {
  const text = SIMULATIONS[Math.floor(Math.random() * SIMULATIONS.length)];
  const data = await Platform.simulate(text);
  if (!data.ok) {
    showToast({ tone: 'error', title: '模拟失败', text: data.error });
    return;
  }
  if (data.detection.isReset) {
    showToast({ tone: 'alert', title: '模拟成功：触发重置警报', text: `得分 ${data.detection.score}，系统通知已发送` });
  } else {
    showToast({ tone: 'info', title: '模拟未触发警报', text: `得分 ${data.detection.score}，低于阈值` });
  }
  await Promise.all([loadAlerts(), loadTweets(true)]);
}

async function rescan() {
  const data = await Platform.rescan();
  showToast({
    tone: 'info',
    title: '重新扫描完成',
    text: `扫描 ${data.scanned} 条推文，命中 ${data.alerts} 条重置警报`,
  });
  await Promise.all([loadAlerts(), loadTweets(true)]);
}

async function testNotify() {
  await Platform.testNotify();
  showToast({ tone: 'info', title: '已发送测试通知', text: '看看屏幕右上角有没有弹出通知。' });
}

/** 把粘贴内容解析出的两个值填进输入框，并给出即时反馈 */
function applyCookieText(text) {
  const { authToken, ct0 } = parseXTokens(text);
  const authInput = $('#xAuthToken');
  const ct0Input = $('#xCt0');
  const hint = $('#cookieHint');
  if (!authInput || !ct0Input || !hint) return false;
  if (authToken && ct0) {
    authInput.value = authToken;
    authInput.dataset.masked = 'false';
    ct0Input.value = ct0;
    ct0Input.dataset.masked = 'false';
    hint.textContent = `已识别 auth_token（${authToken.length} 字符）+ ct0（${ct0.length} 字符）→ 点「保存设置」生效`;
    hint.style.color = 'var(--ok)';
    return true;
  }
  hint.textContent = authToken
    ? '只识别到 auth_token，还缺 ct0'
    : '未识别到 Cookie（内容需包含 auth_token 和 ct0）';
  hint.style.color = 'var(--bad)';
  return false;
}

async function pasteCookieFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text?.trim()) {
      showToast({ tone: 'info', title: '剪贴板是空的', text: '先在浏览器里 DevTools → 任意 x.com 请求 → 右键 Copy as cURL' });
      return;
    }
    if (applyCookieText(text)) {
      showToast({ tone: 'info', title: '已从剪贴板提取 Cookie', text: '点「保存设置」生效' });
    } else {
      showToast({ tone: 'error', title: '没识别到完整 Cookie', text: '请确认复制的是 Copy as cURL 的完整内容' });
    }
  } catch {
    showToast({ tone: 'info', title: '无法直接读剪贴板', text: '请手动粘贴到 auth_token 输入框（会自动拆分）' });
  }
}

async function xLogin() {
  const result = await Platform.xLogin();
  if (result?.unsupported) {
    showToast({ tone: 'info', title: '仅桌面应用支持', text: '浏览器模式请用「从剪贴板导入」。' });
  } else if (result?.ok) {
    showToast({ tone: 'info', title: '已打开 X 登录窗口', text: '用邮箱/手机号登录，完成后窗口会自动关闭并保存 Cookie。' });
  } else {
    showToast({ tone: 'error', title: '打开登录窗口失败', text: result?.error ?? '未知错误' });
  }
}


async function exportData() {
  const result = await Platform.exportData();
  if (result?.ok) {
    showToast({
      tone: 'info',
      title: '已导出全部推文',
      text: result.path ? `保存到 ${result.path}` : '浏览器已开始下载',
    });
  } else if (!result?.canceled) {
    showToast({ tone: 'error', title: '导出失败', text: result?.error ?? '未知错误' });
  }
}

async function testAi() {
  const el = $('#aiTestResult');
  el.textContent = '判定中…';
  el.style.color = 'var(--text-3)';
  const result = await Platform.testAi('Reset all propagated. Sweet dreams.');
  if (result.ok) {
    el.textContent = `${result.verdict.isReset ? '✓ 公告' : '✗ 非公告'} · ${result.verdict.engine} · ${result.verdict.reason}`;
    el.style.color = result.verdict.isReset ? 'var(--ok)' : 'var(--text-2)';
  } else {
    el.textContent = result.error;
    el.style.color = 'var(--bad)';
  }
}

async function setRunning(next) {
  await Platform.control(next ? 'start' : 'stop');
}

/* ── 事件绑定 ──────────────────────────────────────────── */

function bindEvents() {
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!/^https?:\/\//.test(href)) return;
    if (Platform.kind === 'tauri') {
      event.preventDefault();
      Platform.openExternal(href);
    }
  });

  document.addEventListener(
    'error',
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (img.dataset.fallback === 'avatar') {
        const div = document.createElement('div');
        div.className = 'avatar avatar-fallback';
        div.textContent = img.dataset.initial || 'T';
        img.replaceWith(div);
      } else if (img.dataset.fallback === 'media') {
        const link = img.closest('a');
        const grid = img.closest('.media-grid');
        link?.remove();
        if (grid && !grid.children.length) grid.remove();
      }
    },
    true,
  );

  $('#themeBtn').addEventListener('click', () => {
    const current = localStorage.getItem('theme') ?? 'system';
    const next = THEME_MODES[(THEME_MODES.indexOf(current) + 1) % THEME_MODES.length];
    localStorage.setItem('theme', next);
    applyThemeMode(next);
    showToast({ tone: 'info', title: `主题：${themeLabel(next)}` });
  });

  $('#pollBtn').addEventListener('click', pollNow);
  $('#loadMore').addEventListener('click', () => loadTweets(false));

  $('#feedFilters').addEventListener('click', (event) => {
    const btn = event.target.closest('.chip');
    if (!btn) return;
    $('#feedFilters .chip.active')?.classList.remove('active');
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    loadTweets(true);
  });

  let searchTimer;
  $('#searchInput').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = event.target.value.trim();
      loadTweets(true);
    }, 280);
  });

  // 掩码字段聚焦时清空，方便直接输入新值
  $('#settings').addEventListener('focusin', (event) => {
    const input = event.target;
    if (input?.dataset?.masked === 'true') {
      input.value = '';
      input.dataset.masked = 'false';
    }
  });

  // 往 auth_token / ct0 输入框里整段粘贴 cURL 时，自动拆分填入
  $('#settings').addEventListener('input', (event) => {
    const input = event.target;
    if (!input || (input.id !== 'xAuthToken' && input.id !== 'xCt0')) return;
    const value = input.value ?? '';
    if (value.includes('auth_token=') && value.includes('ct0=')) {
      input.dataset.masked = 'false';
      if (applyCookieText(value)) {
        showToast({ tone: 'info', title: '已从粘贴内容自动提取 Cookie', text: '点「保存设置」生效' });
      }
    }
  });

  $('#settings').addEventListener('click', async (event) => {
    const switchEl = event.target.closest('.switch');
    if (switchEl) {
      const field = switchEl.dataset.field;
      if (field === 'running') {
        const next = switchEl.getAttribute('aria-checked') !== 'true';
        switchEl.setAttribute('aria-checked', String(next));
        await setRunning(next);
        showToast({ tone: 'info', title: next ? '监控已恢复' : '监控已暂停' });
        setTimeout(renderHero, 350);
      } else if (field === 'autostart') {
        const next = switchEl.getAttribute('aria-checked') !== 'true';
        switchEl.setAttribute('aria-checked', String(next));
        const result = await Platform.setAutostart(next);
        state.config.autostart = next;
        showToast({
          tone: result?.ok ? 'info' : 'error',
          title: next ? '已开启开机自启' : '已关闭开机自启',
          text: result?.ok ? '' : '设置失败，可稍后重试',
        });
      } else {
        const next = switchEl.getAttribute('aria-checked') !== 'true';
        switchEl.setAttribute('aria-checked', String(next));
        if (field === 'soundOn') {
          const hint = switchEl.closest('.setting-row').querySelector('.setting-hint');
          hint.textContent = next ? 'Glass' : '关闭';
        }
      }
      return;
    }

    const seg = event.target.closest('.segmented[data-field="intervalSec"] button');
    if (seg) {
      seg.parentElement.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      seg.classList.add('active');
      return;
    }

    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'save-settings') saveSettings();
    else if (action === 'simulate') simulate();
    else if (action === 'test-notify') testNotify();
    else if (action === 'rescan') rescan();
    else if (action === 'export') exportData();
    else if (action === 'test-ai') testAi();
    else if (action === 'x-login') xLogin();
    else if (action === 'paste-cookie') pasteCookieFromClipboard();
  });

  $('#hero').addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'resume') {
      await setRunning(true);
      showToast({ tone: 'info', title: '监控已恢复' });
      return;
    }
    const copyBtn = event.target.closest('[data-copy-id]');
    if (copyBtn) {
      const tweet = state.alerts.find((a) => a.id === copyBtn.dataset.copyId);
      if (tweet) {
        await navigator.clipboard.writeText(tweet.text);
        showToast({ tone: 'info', title: '已复制推文内容' });
      }
    }
  });
}

/* ── SSE ──────────────────────────────────────────────── */

function connectEvents() {
  Platform.subscribe({
    status: (payload) => {
      const prevRunning = state.status?.running;
      state.status = payload;
      renderStatus();
      if (prevRunning !== state.status.running) renderHero();
    },
    stats: (payload) => {
      state.stats = payload;
      renderStats();
    },
    tweets: (tweets) => {
      const matches = (t) =>
        (state.filter !== 'reset' || t.isReset) &&
        (state.filter !== 'media' || (t.media ?? []).length > 0) &&
        (!state.q || t.text.toLowerCase().includes(state.q.toLowerCase()));
      const oldestVisible = state.tweets[state.tweets.length - 1]?.createdTs ?? 0;
      const listFull = state.tweets.length >= state.pageSize;
      let added = 0;
      for (const tweet of tweets) {
        if (state.tweetIds.has(tweet.id)) continue;
        state.tweetIds.add(tweet.id);
        state.tweetsTotal += 1;
        if (!matches(tweet)) continue;
        if (listFull && tweet.createdTs < oldestVisible) continue;
        state.tweets.push(tweet);
        added += 1;
      }
      if (added) {
        // 实时插入的推文按发布时间排序，避免历史补录把老推文顶到最前
        state.tweets.sort((a, b) => b.createdTs - a.createdTs);
        renderFeed();
      } else {
        $('#feedCount').textContent = `${state.tweets.length} / ${state.tweetsTotal}`;
      }
    },
    alert: ({ tweet }) => {
      showToast({
        tone: 'alert',
        title: '检测到 Codex 重置公告',
        text: tweet.text,
        action: tweet.permalink ? '查看推文' : undefined,
        actionHref: tweet.permalink,
      });
      loadAlerts().then(() => loadTweets(true));
    },
    config: (payload) => {
      state.config = payload;
      renderSettings();
      renderHero();
    },
    'graphql-error': (message) => {
      if (!/Cookie/.test(String(message))) return;
      if (state.lastGraphqlToast === message) return;
      state.lastGraphqlToast = message;
      showToast({
        tone: 'error',
        title: 'X Cookie 失效',
        text: `${message} — 请到设置里重新登录获取`,
        timeout: 15000,
      });
    },
    'x-cookie': (payload) => {
      if (payload?.ok) {
        state.xCookieSet = true;
        renderSettings();
        showToast({ tone: 'info', title: '已获取并保存 X Cookie', text: '内部接口抓取已启用，下一轮轮询生效。' });
      } else {
        showToast({ tone: 'error', title: '未获取到 Cookie', text: payload?.error ?? '请重试' });
      }
    },
    error: () => {
      const chip = $('#statusChip');
      chip.className = 'status-chip warn';
      $('#statusText').textContent = '连接中断，正在重连…';
    },
  });
}

/* ── 启动 ──────────────────────────────────────────────── */

const THEME_MODES = ['system', 'light', 'dark'];
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

function themeLabel(mode) {
  return mode === 'system' ? '跟随系统' : mode === 'light' ? '亮色' : '暗色';
}

function applyThemeMode(mode) {
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.dataset.theme =
    mode === 'system' ? (systemTheme.matches ? 'dark' : 'light') : mode;
  const btn = $('#themeBtn');
  if (btn) btn.title = `主题：${themeLabel(mode)}（点击切换）`;
}

async function boot() {
  const urlTheme = new URLSearchParams(location.search).get('theme');
  const savedMode =
    urlTheme === 'light' || urlTheme === 'dark'
      ? urlTheme
      : localStorage.getItem('theme') ?? 'system';
  applyThemeMode(THEME_MODES.includes(savedMode) ? savedMode : 'system');

  systemTheme.addEventListener('change', () => {
    if ((localStorage.getItem('theme') ?? 'system') === 'system') applyThemeMode('system');
  });

  const data = await Platform.getState();
  state.config = data.config;
  state.status = data.status;
  state.stats = data.stats;
  state.account = data.account;
  state.rules = data.rules;
  state.ai = data.ai ?? null;
  state.ocr = data.ocr ?? null;
  state.aiHttpKeySet = Boolean(data.aiHttpKeySet);
  state.xCookieSet = Boolean(data.xCookieSet);
  state.skew = data.serverTime - Date.now();

  bindEvents();
  renderStatus();
  renderStats();
  renderSettings();
  renderRules();
  renderHero();
  connectEvents();
  setInterval(tick, 1000);

  await Promise.all([loadTweets(true), loadAlerts()]);
}

boot().catch((err) => {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="toast tone-error" style="position:fixed;top:74px;right:22px;z-index:100">
      <div class="toast-icon">${ICONS.alert}</div>
      <div class="toast-body"><div class="toast-title">初始化失败</div><div class="toast-text">${esc(err.message)}</div></div>
    </div>`,
  );
});
