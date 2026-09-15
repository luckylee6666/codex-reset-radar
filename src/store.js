import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tweets (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  created_ts     INTEGER NOT NULL,
  full_text      TEXT NOT NULL,
  favorite_count INTEGER NOT NULL DEFAULT 0,
  reply_count    INTEGER NOT NULL DEFAULT 0,
  retweet_count  INTEGER NOT NULL DEFAULT 0,
  quote_count    INTEGER NOT NULL DEFAULT 0,
  permalink      TEXT NOT NULL DEFAULT '',
  avatar         TEXT NOT NULL DEFAULT '',
  author_name    TEXT NOT NULL DEFAULT '',
  author_handle  TEXT NOT NULL DEFAULT '',
  media          TEXT NOT NULL DEFAULT '[]',
  lang           TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT 'live',
  is_reset       INTEGER NOT NULL DEFAULT 0,
  reset_score    REAL NOT NULL DEFAULT 0,
  reset_signals  TEXT NOT NULL DEFAULT '[]',
  notified_at    TEXT,
  seen_at        TEXT NOT NULL,
  ai_verdict     INTEGER,
  ai_confidence  REAL,
  ai_reason      TEXT,
  ai_engine      TEXT,
  ai_at          TEXT,
  ocr_text       TEXT,
  ocr_at         TEXT,
  translation    TEXT,
  translated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tweets_created ON tweets (created_ts DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_reset ON tweets (is_reset, created_ts DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function ensureColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(tweets)').all().map((row) => row.name));
  const additions = [
    ['ai_verdict', 'ai_verdict INTEGER'],
    ['ai_confidence', 'ai_confidence REAL'],
    ['ai_reason', 'ai_reason TEXT'],
    ['ai_engine', 'ai_engine TEXT'],
    ['ai_at', 'ai_at TEXT'],
    ['ocr_text', 'ocr_text TEXT'],
    ['ocr_at', 'ocr_at TEXT'],
    ['translation', 'translation TEXT'],
    ['translated_at', 'translated_at TEXT'],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE tweets ADD COLUMN ${ddl}`);
  }
}

function rowOut(r) {
  if (!r) return null;
  return {
    id: r.id,
    createdAt: r.created_at,
    createdTs: r.created_ts,
    text: r.full_text,
    favoriteCount: r.favorite_count,
    replyCount: r.reply_count,
    retweetCount: r.retweet_count,
    quoteCount: r.quote_count,
    permalink: r.permalink,
    avatar: r.avatar,
    authorName: r.author_name,
    authorHandle: r.author_handle,
    media: safeJson(r.media, []),
    lang: r.lang,
    source: r.source,
    isReset: Boolean(r.is_reset),
    resetScore: r.reset_score,
    resetSignals: safeJson(r.reset_signals, []),
    notifiedAt: r.notified_at,
    aiVerdict: r.ai_verdict === null || r.ai_verdict === undefined ? null : Boolean(r.ai_verdict),
    aiConfidence: r.ai_confidence ?? null,
    aiReason: r.ai_reason ?? null,
    aiEngine: r.ai_engine ?? null,
    aiAt: r.ai_at ?? null,
    ocrText: r.ocr_text ?? null,
    ocrAt: r.ocr_at ?? null,
    translation: r.translation ?? null,
    translatedAt: r.translated_at ?? null,
  };
}

export function openStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  ensureColumns(db);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO tweets
      (id, created_at, created_ts, full_text,
       favorite_count, reply_count, retweet_count, quote_count,
       permalink, avatar, author_name, author_handle, media, lang, source,
       is_reset, reset_score, reset_signals, notified_at, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', NULL, ?)
  `);

  function upsertTweets(tweets, source = 'live') {
    const now = new Date().toISOString();
    const inserted = [];
    db.exec('BEGIN');
    try {
      for (const t of tweets) {
        const result = insertStmt.run(
          t.id,
          t.createdAt,
          t.createdTs,
          t.text,
          t.favoriteCount ?? 0,
          t.replyCount ?? 0,
          t.retweetCount ?? 0,
          t.quoteCount ?? 0,
          t.permalink ?? '',
          t.avatar ?? '',
          t.authorName ?? '',
          t.authorHandle ?? '',
          JSON.stringify(t.media ?? []),
          t.lang ?? '',
          source,
          now,
        );
        if (result.changes > 0) inserted.push(t);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { inserted };
  }

  function setDetection(id, { isReset, score, signals }, finalIsReset = isReset) {
    db.prepare('UPDATE tweets SET is_reset = ?, reset_score = ?, reset_signals = ? WHERE id = ?').run(
      finalIsReset ? 1 : 0,
      Math.round(score * 100) / 100,
      JSON.stringify(signals ?? []),
      id,
    );
  }

  function setAiVerdict(id, { isReset, confidence, reason, engine }) {
    db.prepare(
      `UPDATE tweets SET is_reset = ?, ai_verdict = ?, ai_confidence = ?, ai_reason = ?, ai_engine = ?, ai_at = ?
       WHERE id = ?`,
    ).run(
      isReset ? 1 : 0,
      isReset ? 1 : 0,
      confidence ?? null,
      reason ?? '',
      engine ?? '',
      new Date().toISOString(),
      id,
    );
  }

  function pendingAiCandidates(limit = 50) {
    return db
      .prepare('SELECT * FROM tweets WHERE ai_at IS NULL ORDER BY created_ts DESC LIMIT ?')
      .all(limit)
      .map(rowOut);
  }

  function clearAiVerdict(id) {
    db.prepare('UPDATE tweets SET ai_verdict = NULL, ai_confidence = NULL, ai_reason = NULL, ai_engine = NULL, ai_at = NULL WHERE id = ?').run(id);
  }

  function setOcrText(id, text) {
    db.prepare('UPDATE tweets SET ocr_text = ?, ocr_at = ? WHERE id = ?').run(
      text ?? '',
      new Date().toISOString(),
      id,
    );
  }

  function setTranslation(id, text) {
    db.prepare('UPDATE tweets SET translation = ?, translated_at = ? WHERE id = ?').run(
      text ?? '',
      new Date().toISOString(),
      id,
    );
  }

  function pendingOcrCandidates(limit = 50, days = 7) {
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    return db
      .prepare(
        `SELECT * FROM tweets
         WHERE ocr_at IS NULL AND is_reset = 0 AND media != '[]'
           AND source != 'simulate' AND created_ts >= ?
         ORDER BY created_ts DESC LIMIT ?`,
      )
      .all(cutoff, limit)
      .map(rowOut);
  }

  function markNotified(ids, at = new Date().toISOString()) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE tweets SET notified_at = ? WHERE id IN (${placeholders})`).run(at, ...ids);
  }

  function getTweets({ limit = 60, offset = 0, resetOnly = false, q = '', hours = 0 } = {}) {
    const where = [];
    const args = [];
    if (resetOnly) where.push('is_reset = 1');
    if (q) {
      where.push('full_text LIKE ?');
      args.push(`%${q}%`);
    }
    if (hours > 0) {
      where.push('created_ts >= ?');
      args.push(Date.now() - hours * 3600 * 1000);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM tweets ${whereSql}`).get(...args).c;
    const rows = db
      .prepare(`SELECT * FROM tweets ${whereSql} ORDER BY created_ts DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
    return { total, items: rows.map(rowOut) };
  }

  function getTweet(id) {
    return rowOut(db.prepare('SELECT * FROM tweets WHERE id = ?').get(id));
  }

  function hasTweet(id) {
    return Boolean(db.prepare('SELECT 1 AS x FROM tweets WHERE id = ?').get(id));
  }

  function getAlerts(limit = 50) {
    return db
      .prepare('SELECT * FROM tweets WHERE is_reset = 1 ORDER BY created_ts DESC LIMIT ?')
      .all(limit)
      .map(rowOut);
  }

  function pendingFreshAlerts(freshHours) {
    const cutoff = Date.now() - freshHours * 3600 * 1000;
    return db
      .prepare(
        `SELECT * FROM tweets
         WHERE is_reset = 1 AND notified_at IS NULL AND created_ts >= ?
         ORDER BY created_ts DESC`,
      )
      .all(cutoff)
      .map(rowOut);
  }

  function getStats() {
    const total = db.prepare('SELECT COUNT(*) AS c FROM tweets').get().c;
    const resetCount = db.prepare('SELECT COUNT(*) AS c FROM tweets WHERE is_reset = 1').get().c;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const todayCount = db
      .prepare('SELECT COUNT(*) AS c FROM tweets WHERE created_ts >= ?')
      .get(midnight.getTime()).c;
    const lastTweetTs =
      db.prepare('SELECT MAX(created_ts) AS m FROM tweets').get().m ?? null;
    const lastAlertTs =
      db.prepare('SELECT MAX(created_ts) AS m FROM tweets WHERE is_reset = 1').get().m ?? null;
    return { total, resetCount, todayCount, lastTweetTs, lastAlertTs };
  }

  function allTweets() {
    return db.prepare('SELECT * FROM tweets ORDER BY created_ts ASC').all().map(rowOut);
  }

  function getMeta(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  function setMeta(key, value) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      key,
      JSON.stringify(value),
    );
  }

  function close() {
    db.close();
  }

  return {
    raw: db,
    upsertTweets,
    setDetection,
    setAiVerdict,
    pendingAiCandidates,
    clearAiVerdict,
    setOcrText,
    setTranslation,
    pendingOcrCandidates,
    markNotified,
    getTweets,
    getTweet,
    hasTweet,
    getAlerts,
    pendingFreshAlerts,
    getStats,
    allTweets,
    getMeta,
    setMeta,
    close,
  };
}
