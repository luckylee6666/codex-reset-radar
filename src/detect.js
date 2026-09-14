const LIMIT_RE =
  /\b(?:rate\s*limits?|usage\s*limits?|message\s*limits?|request\s*limits?|limits?|quota|credits?|allowance|capacity|usage)\b/giu;
const RESET_RE =
  /\b(?:reset(?:s|ting|ted|ing|ed)?|refill(?:ed|ing)?|replenish(?:ed|ing)?|restore(?:d)?|topped\s+up)\b/giu;
const ANNOUNCE_RE =
  /\b(?:we|i)(?:'ve|'re|'m|\s+have|\s+are|\s+am)?\s+(?:(?:just|already|now|officially|finally)\s+)*(?:reset(?:ting|ing)?|refill(?:ed|ing)?|replenished|restored)\b/giu;
const CODEX_RE = /\bcodex\b/giu;
const WINDOW_RE = /\b(?:5h|5-hour|five-hour|weekly|daily|hourly|hours?)\b/giu;
const STANDALONE_RESET_RE =
  /(?:^|[\n.!?]\s*)(?:a|the|all|another|full|big|quick)?\s*reset(?:s|ting|ing)?\b/giu;

const PROXIMITY_CHARS = 60;

const VETO_RULES = [
  {
    id: 'veto-tech',
    label: '技术语境（git / 设备 / 会话等）',
    weight: -6,
    re: /\b(?:git|hard|factory|password|passcode|session|device|router|browser|computer|machine)\s*(?:-|\s)?reset(?:s|ting)?\b/giu,
  },
  {
    id: 'veto-object',
    label: '非限额对象（密码 / 设置 / 配置等）',
    weight: -6,
    re: /\breset\s+(?:\w+\s+){0,4}(?:password|passcode|settings?|preferences|config(?:uration)?|profile|device|phone|computer|console|account|api\s*key)s?\b/giu,
  },
  {
    id: 'veto-software',
    label: '代码 / 会话语境',
    weight: -6,
    re: /\breset(?:ting)?\s+(?:the\s+)?(?:repo(?:sitory)?|branch|code|conversation|chat|thread|context)\b/giu,
  },
  {
    id: 'veto-schedule',
    label: '未来 / 周期表述（非即时重置）',
    weight: -6,
    re: /\b(?:will|won't|would|should)\s+(?:be\s+)?reset\b|\bresets?\s+(?:in|every|each)\s+\d|\bresets?\s+(?:every|each)\b/giu,
  },
  {
    id: 'veto-when',
    label: '说明性表述（何时重置 / 查看状态）',
    weight: -6,
    re: /\bwhen\s+(?:\w+\s+){0,5}?reset(?:s|ting)?\b|\b(?:see|check|view|show(?:s|ing)?)\s+(?:when|if)\b[^.!?\n]{0,40}reset/giu,
  },
  {
    id: 'veto-completion',
    label: '重置完成 / 推送状态（非公告）',
    weight: -6,
    re: /\bresets?\b(?:\s+\w+){0,3}\s+(?:propagated|rolled\s+out|deployed)\b/giu,
  },
];

function matchAll(re, text) {
  const fresh = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out = [];
  let m;
  while ((m = fresh.exec(text)) !== null) {
    out.push({ match: m[0], index: m.index });
    if (m.index === fresh.lastIndex) fresh.lastIndex += 1;
  }
  return out;
}

export function detectReset(text, { extraKeywords = [], threshold = 3 } = {}) {
  const signals = [];
  const push = (id, label, weight, match) =>
    signals.push({ id, label, weight, match: String(match).slice(0, 80) });

  const limitMatches = matchAll(LIMIT_RE, text);
  const resetMatches = matchAll(RESET_RE, text);

  proximity: for (const a of limitMatches) {
    for (const b of resetMatches) {
      const [left, right] = a.index <= b.index ? [a, b] : [b, a];
      const gap = right.index - (left.index + left.match.length);
      if (gap >= 0 && gap <= PROXIMITY_CHARS) {
        const pair = `${left.match} … ${right.match}`;
        push('limit-reset-proximity', '限额与重置相邻出现', 3, pair);
        break proximity;
      }
    }
  }

  for (const m of matchAll(ANNOUNCE_RE, text)) {
    push('announce', '第一人称公告语气', 2, m.match);
    break;
  }

  for (const m of matchAll(/\bbanked\s+resets?\b|\bcredit\s+(?:\w+\s+){0,10}?resets?\b/giu, text)) {
    push('banked-reset', '存入/发放重置额度', 3, m.match);
    break;
  }

  for (const m of matchAll(STANDALONE_RESET_RE, text)) {
    push('standalone-reset', '句首独立重置公告口吻', 3, m.match.trim());
    break;
  }

  if (CODEX_RE.test(text)) push('codex-context', '提及 Codex', 1, 'codex');
  if (WINDOW_RE.test(text) && signals.length) {
    push('window-context', '提及限额窗口', 1, (text.match(WINDOW_RE) ?? [''])[0]);
  }

  for (const rawKeyword of extraKeywords) {
    const keyword = String(rawKeyword).trim();
    if (!keyword) continue;
    const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx >= 0) push('custom-keyword', `自定义关键词：${keyword}`, 3, keyword);
  }

  for (const rule of VETO_RULES) {
    const m = matchAll(rule.re, text)[0];
    if (m) push(rule.id, rule.label, rule.weight, m.match);
  }

  const rawScore = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = Math.max(0, rawScore);
  return { isReset: score >= threshold, score, rawScore, signals };
}

export function getRuleInfo() {
  return {
    thresholdDefault: 3,
    positive: [
      { id: 'limit-reset-proximity', label: '限额词与重置词在 60 字符内相邻出现', weight: 3 },
      { id: 'announce', label: '第一人称公告语气（we/I + reset）', weight: 2 },
      { id: 'banked-reset', label: '存入 / 发放重置额度（banked reset）', weight: 3 },
      { id: 'standalone-reset', label: '句首独立重置口吻（Reset all… / A reset…）', weight: 3 },
      { id: 'codex-context', label: '提及 Codex', weight: 1 },
      { id: 'window-context', label: '提及限额窗口（5h / weekly…）', weight: 1 },
      { id: 'custom-keyword', label: '自定义关键词命中', weight: 3 },
    ],
    negative: VETO_RULES.map((r) => ({ id: r.id, label: r.label, weight: r.weight })),
  };
}
