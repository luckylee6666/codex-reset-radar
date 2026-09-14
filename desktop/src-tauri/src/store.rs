use crate::detect::Detection;
use crate::fetch::Tweet;
use rusqlite::{params, params_from_iter, Connection, Row};
use serde_json::{json, Value};
use std::path::Path;

const SCHEMA: &str = r#"
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
  ocr_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_tweets_created ON tweets (created_ts DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_reset ON tweets (is_reset, created_ts DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

fn parse_json_or(value: &str, fallback: Value) -> Value {
    serde_json::from_str(value).unwrap_or(fallback)
}

fn row_to_json(row: &Row) -> rusqlite::Result<Value> {
    let media: String = row.get("media")?;
    let signals: String = row.get("reset_signals")?;
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "createdAt": row.get::<_, String>("created_at")?,
        "createdTs": row.get::<_, i64>("created_ts")?,
        "text": row.get::<_, String>("full_text")?,
        "favoriteCount": row.get::<_, i64>("favorite_count")?,
        "replyCount": row.get::<_, i64>("reply_count")?,
        "retweetCount": row.get::<_, i64>("retweet_count")?,
        "quoteCount": row.get::<_, i64>("quote_count")?,
        "permalink": row.get::<_, String>("permalink")?,
        "avatar": row.get::<_, String>("avatar")?,
        "authorName": row.get::<_, String>("author_name")?,
        "authorHandle": row.get::<_, String>("author_handle")?,
        "media": parse_json_or(&media, json!([])),
        "lang": row.get::<_, String>("lang")?,
        "source": row.get::<_, String>("source")?,
        "isReset": row.get::<_, i64>("is_reset")? != 0,
        "resetScore": row.get::<_, f64>("reset_score")?,
        "resetSignals": parse_json_or(&signals, json!([])),
        "notifiedAt": row.get::<_, Option<String>>("notified_at")?,
        "aiVerdict": row.get::<_, Option<i64>>("ai_verdict")?.map(|v| v != 0),
        "aiConfidence": row.get::<_, Option<f64>>("ai_confidence")?,
        "aiReason": row.get::<_, Option<String>>("ai_reason")?,
        "aiEngine": row.get::<_, Option<String>>("ai_engine")?,
        "aiAt": row.get::<_, Option<String>>("ai_at")?,
        "ocrText": row.get::<_, Option<String>>("ocr_text")?,
        "ocrAt": row.get::<_, Option<String>>("ocr_at")?,
    }))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn migrate_ai_columns(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(tweets)")
        .map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let additions = [
        ("ai_verdict", "ALTER TABLE tweets ADD COLUMN ai_verdict INTEGER"),
        ("ai_confidence", "ALTER TABLE tweets ADD COLUMN ai_confidence REAL"),
        ("ai_reason", "ALTER TABLE tweets ADD COLUMN ai_reason TEXT"),
        ("ai_engine", "ALTER TABLE tweets ADD COLUMN ai_engine TEXT"),
        ("ai_at", "ALTER TABLE tweets ADD COLUMN ai_at TEXT"),
        ("ocr_text", "ALTER TABLE tweets ADD COLUMN ocr_text TEXT"),
        ("ocr_at", "ALTER TABLE tweets ADD COLUMN ocr_at TEXT"),
    ];
    for (name, ddl) in additions {
        if !columns.iter().any(|c| c == name) {
            conn.execute(ddl, []).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        migrate_ai_columns(&conn)?;
        Ok(Self { conn })
    }

    pub fn upsert_tweets(&mut self, tweets: &[Tweet], source: &str) -> Result<Vec<Tweet>, String> {
        let seen_at = now_iso();
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut inserted = Vec::new();
        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR IGNORE INTO tweets
                     (id, created_at, created_ts, full_text,
                      favorite_count, reply_count, retweet_count, quote_count,
                      permalink, avatar, author_name, author_handle, media, lang, source,
                      is_reset, reset_score, reset_signals, notified_at, seen_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', NULL, ?)",
                )
                .map_err(|e| e.to_string())?;
            for tweet in tweets {
                let media = serde_json::to_string(&tweet.media).unwrap_or_else(|_| "[]".into());
                let changed = stmt
                    .execute(params![
                        tweet.id,
                        tweet.created_at,
                        tweet.created_ts,
                        tweet.text,
                        tweet.favorite_count,
                        tweet.reply_count,
                        tweet.retweet_count,
                        tweet.quote_count,
                        tweet.permalink,
                        tweet.avatar,
                        tweet.author_name,
                        tweet.author_handle,
                        media,
                        tweet.lang,
                        source,
                        seen_at,
                    ])
                    .map_err(|e| e.to_string())?;
                if changed > 0 {
                    inserted.push(tweet.clone());
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(inserted)
    }

    pub fn set_detection(
        &mut self,
        id: &str,
        detection: &Detection,
        final_is_reset: bool,
    ) -> Result<(), String> {
        let signals = serde_json::to_string(&detection.signals).unwrap_or_else(|_| "[]".into());
        let score = (detection.score * 100.0).round() / 100.0;
        self.conn
            .execute(
                "UPDATE tweets SET is_reset = ?, reset_score = ?, reset_signals = ? WHERE id = ?",
                params![if final_is_reset { 1 } else { 0 }, score, signals, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_ai_verdict(&mut self, id: &str, verdict: &crate::ai::Verdict) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE tweets SET is_reset = ?, ai_verdict = ?, ai_confidence = ?, ai_reason = ?, ai_engine = ?, ai_at = ?
                 WHERE id = ?",
                params![
                    if verdict.is_reset { 1 } else { 0 },
                    if verdict.is_reset { 1 } else { 0 },
                    verdict.confidence,
                    verdict.reason,
                    verdict.engine,
                    now_iso(),
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn pending_ai_candidates(&self, limit: u32) -> Vec<Value> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM tweets WHERE ai_at IS NULL ORDER BY created_ts DESC LIMIT ?")
            .expect("prepare ai candidates");
        stmt.query_map(params![limit], row_to_json)
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    pub fn clear_ai_verdict(&mut self, id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE tweets SET ai_verdict = NULL, ai_confidence = NULL, ai_reason = NULL, ai_engine = NULL, ai_at = NULL WHERE id = ?",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_ocr_text(&mut self, id: &str, text: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE tweets SET ocr_text = ?, ocr_at = ? WHERE id = ?",
                params![text, now_iso(), id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn pending_ocr_candidates(&self, limit: u32, days: u32) -> Vec<Value> {
        let cutoff =
            chrono::Utc::now().timestamp_millis() - i64::from(days) * 24 * 3600 * 1000;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT * FROM tweets
                 WHERE ocr_at IS NULL AND is_reset = 0 AND media != '[]'
                   AND source != 'simulate' AND created_ts >= ?
                 ORDER BY created_ts DESC LIMIT ?",
            )
            .expect("prepare ocr candidates");
        stmt.query_map(params![cutoff, limit], row_to_json)
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    pub fn mark_notified(&mut self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let now = now_iso();
        for id in ids {
            self.conn
                .execute(
                    "UPDATE tweets SET notified_at = ? WHERE id = ?",
                    params![now, id],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn get_tweets(
        &self,
        limit: u32,
        offset: u32,
        reset_only: bool,
        q: &str,
        hours: u32,
    ) -> Result<(i64, Vec<Value>), String> {
        let mut where_parts: Vec<String> = Vec::new();
        let mut args: Vec<rusqlite::types::Value> = Vec::new();

        if reset_only {
            where_parts.push("is_reset = 1".into());
        }
        if !q.is_empty() {
            where_parts.push("full_text LIKE ?".into());
            args.push(format!("%{q}%").into());
        }
        if hours > 0 {
            where_parts.push("created_ts >= ?".into());
            let cutoff = chrono::Utc::now().timestamp_millis() - i64::from(hours) * 3600 * 1000;
            args.push(cutoff.into());
        }
        let where_sql = if where_parts.is_empty() {
            "1=1".to_string()
        } else {
            where_parts.join(" AND ")
        };

        let total: i64 = self
            .conn
            .query_row(
                &format!("SELECT COUNT(*) FROM tweets WHERE {where_sql}"),
                params_from_iter(args.iter()),
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let mut list_args = args.clone();
        list_args.push(i64::from(limit).into());
        list_args.push(i64::from(offset).into());
        let mut stmt = self
            .conn
            .prepare(&format!(
                "SELECT * FROM tweets WHERE {where_sql} ORDER BY created_ts DESC LIMIT ? OFFSET ?"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(list_args.iter()), row_to_json)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        Ok((total, rows))
    }

    pub fn get_tweet(&self, id: &str) -> Option<Value> {
        self.conn
            .query_row("SELECT * FROM tweets WHERE id = ?", params![id], row_to_json)
            .ok()
    }

    pub fn has_tweet(&self, id: &str) -> bool {
        self.conn
            .query_row("SELECT 1 FROM tweets WHERE id = ?", params![id], |_| Ok(()))
            .is_ok()
    }

    pub fn get_alerts(&self, limit: u32) -> Vec<Value> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM tweets WHERE is_reset = 1 ORDER BY created_ts DESC LIMIT ?")
            .expect("prepare alerts");
        stmt.query_map(params![limit], row_to_json)
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    pub fn pending_fresh_alerts(&self, fresh_hours: f64) -> Vec<Value> {
        let cutoff =
            chrono::Utc::now().timestamp_millis() - (fresh_hours * 3600.0 * 1000.0) as i64;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT * FROM tweets
                 WHERE is_reset = 1 AND notified_at IS NULL AND created_ts >= ?
                 ORDER BY created_ts DESC",
            )
            .expect("prepare pending alerts");
        stmt.query_map(params![cutoff], row_to_json)
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    pub fn get_stats(&self) -> Value {
        let total: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM tweets", [], |r| r.get(0))
            .unwrap_or(0);
        let reset_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM tweets WHERE is_reset = 1", [], |r| r.get(0))
            .unwrap_or(0);
        let mut midnight = chrono::Local::now();
        midnight = midnight
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .map(|naive| {
                chrono::TimeZone::from_local_datetime(&chrono::Local, &naive)
                    .single()
                    .unwrap_or_else(chrono::Local::now)
            })
            .unwrap_or_else(chrono::Local::now);
        let today_count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM tweets WHERE created_ts >= ?",
                params![midnight.timestamp_millis()],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let last_tweet_ts: Option<i64> = self
            .conn
            .query_row("SELECT MAX(created_ts) FROM tweets", [], |r| r.get(0))
            .unwrap_or(None);
        let last_alert_ts: Option<i64> = self
            .conn
            .query_row("SELECT MAX(created_ts) FROM tweets WHERE is_reset = 1", [], |r| r.get(0))
            .unwrap_or(None);
        json!({
            "total": total,
            "resetCount": reset_count,
            "todayCount": today_count,
            "lastTweetTs": last_tweet_ts,
            "lastAlertTs": last_alert_ts,
        })
    }

    pub fn all_tweets(&self) -> Vec<Value> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM tweets ORDER BY created_ts ASC")
            .expect("prepare all");
        stmt.query_map([], row_to_json)
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    pub fn get_meta(&self, key: &str) -> Option<Value> {
        self.conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
    }

    pub fn set_meta(&mut self, key: &str, value: &Value) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, serde_json::to_string(value).unwrap_or_else(|_| "null".into())],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
