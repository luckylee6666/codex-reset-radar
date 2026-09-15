import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

/* ── 引擎定义与可用性探测 ─────────────────────────────── */

const ENGINE_DEFS = [
  {
    id: 'claude',
    bin: 'claude',
    knownPaths: ['~/.local/bin/claude', '/usr/local/bin/claude', '/opt/homebrew/bin/claude'],
    args: (prompt) => ['-p', prompt],
  },
  {
    id: 'codex',
    bin: 'codex',
    knownPaths: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '~/.cargo/bin/codex'],
    args: (prompt) => ['exec', '--skip-git-repo-check', prompt],
  },
  {
    id: 'ollama',
    bin: 'ollama',
    knownPaths: ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama'],
    args: (prompt, model) => ['run', model || 'llama3.2', prompt],
  },
];

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function resolveBin(def) {
  for (const candidate of def.knownPaths) {
    const full = expandHome(candidate);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* try next */
    }
  }
  return def.bin; // 交给 PATH
}

const availability = { engines: null, checkedAt: 0 };
const ENGINE_CHECK_TTL = 10 * 60 * 1000;

export function isHttpConfigured(options = {}) {
  return Boolean(options.httpUrl && options.httpModel);
}

/** ollama 的 CLI 是客户端，执行任何命令都会拉起本地服务；
 *  这里只用 TCP 探活（无副作用），避免"探测即启动" */
export function ollamaRunning(timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 11434 });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function listCliEngines(options = {}) {
  if (!availability.engines || Date.now() - availability.checkedAt >= ENGINE_CHECK_TTL) {
    const found = [];
    for (const def of ENGINE_DEFS) {
      if (def.id === 'ollama') continue;
      try {
        await run(resolveBin(def), ['--version'], { timeout: 8000 });
        found.push(def.id);
      } catch {
        /* not available */
      }
    }
    availability.engines = found;
    availability.checkedAt = Date.now();
  }

  const engines = [...availability.engines];
  if (options.engine === 'ollama' || (await ollamaRunning())) {
    engines.push('ollama');
  }
  return engines;
}

export async function listAvailableEngines(options = {}) {
  const engines = [];
  if (isHttpConfigured(options)) engines.push('http');
  engines.push(...(await listCliEngines(options)));
  return engines;
}

/* ── 判定提示词 ───────────────────────────────────────── */

export function buildPrompt(text) {
  return `你是 Codex 用量监控的判定器。判断下面这条推文是否在宣布「用量限额被重置」——即用户看到后应当立刻去使用额度。

判定 true：
- 明确表示刚刚 / 正在 / 即将重置用量限额（含 "reseting" 等拼写错误）
- 额度被补充、发放、存入（banked reset / refill）
- 以公告口吻宣布 reset（如 "All reset for everyone"）

判定 false：
- 重置完成后的状态确认（如 "Reset all propagated"、"reset rolled out"）
- 只是说明何时会重置（"limits reset in 2 hours"）
- 玩笑、调侃、非限额语境（"I feel Theo is in need of a reset"）
- 技术重置（git reset、重置密码 / 配置 / 设备）
- 仅提到 reset 一词但没有重置公告含义

示例：
- "Reset all propagated. Sweet dreams." → false（完成确认）
- "Hi Astra users. A reset and a quick update on quality issues." → true
- "We have reset everyone's limits for gpt-5-codex." → true
- "Your limits will reset at 3pm." → false
- "git reset --hard" → false

推文：
"""
${text}
"""

只输出 JSON，不要任何其他文字：
{"is_reset": true 或 false, "confidence": 0 到 1, "reason": "不超过 20 字的中文理由"}`;
}

export function buildTranslatePrompt(text) {
  return `把下面的推文翻译成简体中文。要求：
- 只输出译文，不要任何解释、标题或前后缀
- 保留 @用户名、#话题、URL、命令与代码原样
- 专有名词保留英文（Codex、ChatGPT、OpenAI 等）
- 口语、俚语、梗按中文习惯意译

推文：
"""
${text}
"""`;
}

export function parseVerdict(stdout) {
  const match = String(stdout).match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[0]);
    if (typeof data.is_reset !== 'boolean') return null;
    return {
      isReset: data.is_reset,
      confidence: Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : null,
      reason: String(data.reason ?? '').slice(0, 80),
    };
  } catch {
    return null;
  }
}

/* ── HTTP 引擎（OpenAI 兼容 / Anthropic 协议） ─────────── */

export function extractHttpContent(data, format = 'openai') {
  if (format === 'anthropic') {
    if (Array.isArray(data?.content)) {
      return data.content.map((part) => part?.text ?? '').join('');
    }
    return '';
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  }
  return '';
}

async function httpContent(prompt, options = {}, timeoutSec = 90) {
  const { httpUrl, httpKey = '', httpModel, httpFormat = 'openai' } = options;
  if (!isHttpConfigured(options)) throw new Error('未配置 HTTP 地址或模型');

  const headers = { 'content-type': 'application/json' };
  let body;
  if (httpFormat === 'anthropic') {
    headers['x-api-key'] = httpKey;
    headers['anthropic-version'] = '2023-06-01';
    body = { model: httpModel, max_tokens: 300, messages: [{ role: 'user', content: prompt }] };
  } else {
    if (httpKey) headers.authorization = `Bearer ${httpKey}`;
    body = { model: httpModel, temperature: 0, messages: [{ role: 'user', content: prompt }] };
  }

  const res = await fetch(httpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(5, timeoutSec) * 1000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return extractHttpContent(data, httpFormat);
}

export async function judgeHttp(prompt, options = {}, timeoutSec = 90) {
  const verdict = parseVerdict(await httpContent(prompt, options, timeoutSec));
  if (!verdict) throw new Error('响应无法解析为判定 JSON');
  return verdict;
}

function cleanText(raw) {
  return String(raw ?? '')
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

async function cliOutput(def, prompt, ollamaModel, timeoutSec) {
  const { stdout } = await run(resolveBin(def), def.args(prompt, ollamaModel), {
    timeout: timeoutSec * 1000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

export function aiOptionsFromConfig(config = {}) {
  return {
    engine: config.aiEngine || 'auto',
    timeoutSec: Math.max(20, Number(config.aiTimeoutSec) || 90),
    ollamaModel: config.aiOllamaModel || '',
    httpUrl: config.aiHttpUrl || '',
    httpKey: config.aiHttpKey || '',
    httpModel: config.aiHttpModel || '',
    httpFormat: config.aiHttpFormat || 'openai',
  };
}

/** 翻译推文为简体中文；返回 { text, engine } 或 { error } */
export async function translateText(text, options = {}) {
  const { engine = 'auto', timeoutSec = 90, ollamaModel = '' } = options;
  const prompt = buildTranslatePrompt(text);
  const order =
    engine === 'auto'
      ? [
          ...(isHttpConfigured(options) ? ['http'] : []),
          'claude',
          'codex',
          ...((await ollamaRunning()) ? ['ollama'] : []),
        ]
      : [engine];
  const errors = [];

  for (const id of order) {
    try {
      let output;
      if (id === 'http') {
        output = await httpContent(prompt, options, timeoutSec);
      } else {
        const def = ENGINE_DEFS.find((e) => e.id === id);
        if (!def) continue;
        output = await cliOutput(def, prompt, ollamaModel, timeoutSec);
      }
      const translated = cleanText(output);
      if (translated) return { text: translated, engine: id };
      errors.push(`${id}: 输出为空`);
    } catch (err) {
      errors.push(`${id}: ${err.killed ? '超时' : err.message.split('\n')[0]}`);
    }
  }
  return { error: errors.join('；') || '没有可用的 AI 引擎' };
}

/* ── 判定入口 ─────────────────────────────────────────── */

export async function judgeTweet(text, options = {}) {
  const { engine = 'auto', timeoutSec = 90, ollamaModel = '' } = options;
  const order =
    engine === 'auto'
      ? [
          ...(isHttpConfigured(options) ? ['http'] : []),
          'claude',
          'codex',
          ...((await ollamaRunning()) ? ['ollama'] : []),
        ]
      : [engine];
  const prompt = buildPrompt(text);
  const errors = [];

  for (const id of order) {
    if (id === 'http') {
      try {
        const verdict = await judgeHttp(prompt, options, timeoutSec);
        return { ...verdict, engine: 'http' };
      } catch (err) {
        errors.push(`http: ${err.message.split('\n')[0]}`);
      }
      continue;
    }

    const def = ENGINE_DEFS.find((e) => e.id === id);
    if (!def) continue;
    try {
      const { stdout } = await run(resolveBin(def), def.args(prompt, ollamaModel), {
        timeout: timeoutSec * 1000,
        maxBuffer: 1024 * 1024,
      });
      const verdict = parseVerdict(stdout);
      if (verdict) return { ...verdict, engine: id };
      errors.push(`${id}: 输出无法解析`);
    } catch (err) {
      errors.push(`${id}: ${err.killed ? '超时' : err.message.split('\n')[0]}`);
    }
  }
  return { error: errors.join('；') || '没有可用的 AI 引擎' };
}
