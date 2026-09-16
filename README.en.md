# Codex Reset Radar

[中文](README.md) | **English**

Monitors [@thsottiaux](https://x.com/thsottiaux) (OpenAI's Codex lead) for **Codex usage-limit reset announcements**.
The moment he announces a reset, you get a system notification — never miss the "quota is back, go use it" window.

![screenshot](docs/screenshot.png)

## Features

- **Four data sources in parallel** (any one working keeps you updated; automatic backoff on rate limits)
  - **Logged-in API**: uses your own X session against X's internal GraphQL, the freshest and most complete source (~20 tweets per round)
  - **Public profile**: no login required, grabs the newest tweet IDs
  - **Search discovery**: Brave / DuckDuckGo rotation to backfill history
  - **Official embed timeline**: fallback
- **Three-stage detection**
  - Rule engine: proximity of limit/reset keywords, announcement tone, banked resets — weighted scoring plus veto rules against false positives
  - AI judge: local CLI (claude / codex / ollama) first, or any OpenAI/Anthropic-compatible HTTP endpoint; falls back to rules when unavailable
  - Image OCR: when he announces with a screenshot, macOS Vision reads the text and feeds it into detection
- **Per-tweet AI translation**: one click to Simplified Chinese (cached locally — no repeated AI cost)
- **Notifications & history**: system notifications (only within the freshness window), local SQLite storage, alert history
- **Desktop resident**: Tauri v2 — menu bar / system tray, close-to-tray, launch at login, native notifications
- **UI**: zero-dependency web UI, dark / light / follow system

## Download

From [Releases](https://github.com/luckylee6666/codex-reset-radar/releases):

- **macOS**: `.dmg` (Universal, arm64 + x64). Unsigned — **right-click → Open** on first launch.
- **Windows**: `.exe` or `.msi`. Unsigned — choose "Run anyway" on the SmartScreen prompt.

## How it works

```
Polling (default 10 min, options 10/15/30/60m)
 ├─ Logged-in API (cookies + X internal GraphQL, most complete)
 ├─ Public profile (no login, newest tweet IDs)
 ├─ Search discovery (every 10 min, engine rotation + cooldown)
 └─ Official timeline (independent backoff, does not block other sources)
      ↓ dedupe into SQLite + fetch full tweets (including parent tweets)
 ├─ Rule engine (text)
 ├─ OCR pass (recent media tweets → image text joins detection)
 └─ AI judge (re-judged with image text, results cached)
      ↓
 Hit → system notification + live UI toast (SSE / Tauri IPC)
      ↓
 Any tweet → AI translation (cached, original/translation collapsible)
```

## Quick start

### Desktop app (recommended)

```bash
pnpm -C desktop install
pnpm app          # run in development
pnpm app:build    # build the app bundle
```

### Browser mode

```bash
pnpm start        # http://127.0.0.1:4173
pnpm poll         # poll once
pnpm simulate "We've reset Codex rate limits"   # inject a fake announcement to test notifications
pnpm test         # unit tests
```

## Configuration (settings panel)

- **Poll / discovery interval**: 10 minutes by default, minimum 10 minutes (shorter = more likely to be rate-limited)
- **X login cookies** (optional; enables the most complete source):
  - "Import from clipboard": in browser DevTools, right-click any x.com request → **Copy as cURL** → click the button to extract `auth_token` / `ct0` automatically
  - Or paste the whole cURL into the auth_token field (auto-split)
  - Cookies are stored locally in `config.json` (mode 600) and never shown back in the UI
- **AI engine**: `auto` tries HTTP endpoint → claude → codex → ollama; HTTP supports OpenAI-compatible and Anthropic protocols; local keyless endpoints (LM Studio / one-api) work too
- **Image OCR**: macOS Vision (compiles a ~20-line Swift helper on first use, cached), requires Xcode Command Line Tools; skipped automatically elsewhere
- Notification toggles/sound, freshness window (default 6h), trigger threshold, custom keywords, RSS fallback

## Project structure

```
src/                    Node implementation (browser mode / development)
  fetch.js              Data sources: timeline, public profile, search discovery, single-tweet fetch
  x-graphql.js          Logged-in API (X internal GraphQL, queryId rotation)
  detect.js             Rule engine (weighted scoring + veto rules)
  ai.js                 AI judging & translation (CLI / HTTP)
  ocr.js + ocr.swift    Image OCR (macOS Vision)
  poller.js store.js server.js notify.js
public/                 Shared frontend (HTTP and Tauri IPC adapters)
desktop/                Tauri v2 desktop app (Rust backend, tray / notifications / autostart)
test/                   Unit tests (node --test + cargo test)
```

## Known limitations

- X endpoints rate-limit (HTTP 429); the app backs off exponentially. Search engines are throttled too
- Login cookies expire; the app will tell you — re-import via "Import from clipboard"
- The in-app login window cannot complete Google / Apple popups (embedded-browser restriction) — use the cURL import instead
- On macOS the notification source is shown as "Script Editor" — a system limitation for unsigned apps; showing your own icon requires signing + notarizing with a Developer ID
- Image OCR is macOS-only; the Windows build is verified on Windows 11 (install/uninstall, polling, UI, system notifications)
- The app is unsigned / unnotarized: right-click to open on first launch; distributing to others requires signing
- Requires network access to X (uses the system proxy)
- Personal tool, not affiliated with OpenAI
