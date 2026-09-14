import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, ensureDataDir } from './config.js';
import { detectReset } from './detect.js';

const run = promisify(execFile);

const state = { status: 'idle', error: null };

export function ocrStatus() {
  return { available: isSupported(), ...state };
}

function isSupported() {
  return process.platform === 'darwin';
}

function binaryPath() {
  return path.join(ensureDataDir(), 'radar-ocr');
}

/** 按需编译 Swift OCR 助手（带缓存，热编译 <1s） */
export async function ensureOcrBinary() {
  if (!isSupported()) throw new Error('OCR 仅支持 macOS');
  const bin = binaryPath();
  if (fs.existsSync(bin)) {
    state.status = 'ready';
    return bin;
  }
  if (state.status === 'compiling') throw new Error('OCR 引擎编译中');
  if (state.status === 'unavailable') throw new Error(state.error);

  state.status = 'compiling';
  try {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'ocr.swift'), 'utf8');
    const sourcePath = path.join(ensureDataDir(), 'radar-ocr.swift');
    fs.writeFileSync(sourcePath, source);
    await run('swiftc', ['-O', '-o', bin, sourcePath], { timeout: 180000 });
    state.status = 'ready';
    return bin;
  } catch (err) {
    state.status = 'unavailable';
    state.error = '需要 Xcode Command Line Tools 才能启用图片 OCR（xcode-select --install）';
    throw new Error(state.error);
  }
}

export async function ocrImage(imagePath) {
  const bin = await ensureOcrBinary();
  const { stdout } = await run(bin, [imagePath], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

export async function downloadImage(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://x.com/' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 8 * 1024 * 1024) throw new Error('图片过大');
  const file = path.join(
    os.tmpdir(),
    `radar-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.img`,
  );
  fs.writeFileSync(file, buffer);
  return file;
}

function pickImage(tweet) {
  return (tweet.media ?? []).find(
    (m) => m.type === 'photo' || /\.(jpe?g|png|webp)(\?|$)/i.test(m.url),
  );
}

export function combinedText(tweet) {
  return tweet.ocrText ? `${tweet.text}\n[图片文字] ${tweet.ocrText}` : tweet.text;
}

/**
 * 图片 OCR 处理：对未判定、带图、近期的推文做 OCR，
 * 用「正文 + 图片文字」重新跑规则引擎；清掉 AI 缓存让它带着图片文字重判。
 */
export async function runOcrPass({ store, config }) {
  const settings = config ?? {};
  if (settings.ocrEnabled === false || !isSupported()) return { ocrApplied: 0, changed: [] };

  const days = Math.max(1, Math.min(60, Number(settings.ocrMaxAgeDays) || 7));
  const limit = Math.max(1, Math.min(5, Number(settings.ocrMaxPerPoll) || 2));
  const candidates = store.pendingOcrCandidates(60, days).slice(0, limit);
  if (!candidates.length) return { ocrApplied: 0, changed: [] };

  let applied = 0;
  const changed = [];
  for (const tweet of candidates) {
    const image = pickImage(tweet);
    if (!image) {
      store.setOcrText(tweet.id, '');
      continue;
    }
    let tempFile = null;
    try {
      tempFile = await downloadImage(image.url);
      const text = await ocrImage(tempFile);
      store.setOcrText(tweet.id, text);
      applied += 1;

      const detection = detectReset(combinedText({ ...tweet, ocrText: text }), {
        extraKeywords: settings.extraKeywords ?? [],
        threshold: settings.resetThreshold ?? 3,
      });
      store.setDetection(tweet.id, detection, detection.isReset);
      store.clearAiVerdict(tweet.id);

      const updated = store.getTweet(tweet.id);
      if (updated && updated.isReset !== tweet.isReset) changed.push(updated);
    } catch (err) {
      if (state.status === 'compiling' || state.status === 'unavailable') break;
      store.setOcrText(tweet.id, '');
    } finally {
      if (tempFile) fs.rmSync(tempFile, { force: true });
    }
  }

  return { ocrApplied: applied, changed };
}
