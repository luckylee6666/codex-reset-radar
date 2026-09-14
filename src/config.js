import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const DATA_DIR = path.join(ROOT, 'data');

export const DEFAULTS = {
  handle: 'thsottiaux',
  intervalSec: 600,
  port: 4173,
  notify: true,
  notifySound: 'Glass',
  freshHours: 6,
  resetThreshold: 3,
  extraKeywords: [],
  rssUrl: '',
  searchDiscovery: true,
  discoveryMaxFetch: 10,
  discoveryIntervalSec: 600,
  profileScrape: true,
  xAuthToken: '',
  xCt0: '',
  xUserTweetsQueryId: '',
  aiJudge: true,
  aiEngine: 'auto',
  aiMaxPerPoll: 3,
  aiTimeoutSec: 90,
  aiOllamaModel: '',
  aiHttpUrl: '',
  aiHttpKey: '',
  aiHttpModel: '',
  aiHttpFormat: 'openai',
  ocrEnabled: true,
  ocrMaxPerPoll: 2,
  ocrMaxAgeDays: 7,
  openBrowser: true,
};

export function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    file = {};
  }
  return { ...DEFAULTS, ...file };
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}
