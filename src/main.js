import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadConfig, ensureDataDir } from './config.js';
import { openStore } from './store.js';
import { Poller } from './poller.js';
import { createServer } from './server.js';
import { fixtureFetcher } from './fetch.js';

const args = process.argv.slice(2);
const once = args.includes('--once');
const noOpen = args.includes('--no-open');
const fixtureArg = args.find((a) => a.startsWith('--fixture='));
const fetchImpl = fixtureArg ? fixtureFetcher(fixtureArg.slice('--fixture='.length)) : null;

const config = loadConfig();
const dataDir = ensureDataDir();
const store = openStore(path.join(dataDir, 'codex-reset.db'));
const poller = new Poller({ config, store, fetchImpl });
const server = createServer({ store, poller, config });

const url = `http://127.0.0.1:${config.port}`;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[38;5;117m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function banner() {
  console.log('');
  console.log(`  ${cyan('◆')} ${bold('Codex Reset Radar')} ${dim('v0.1')}`);
  console.log(`  ${dim('监控')} @${config.handle} ${dim('的 Codex 限额重置公告')}`);
  console.log('');
  console.log(`  ${dim('界面')}   ${cyan(url)}`);
  console.log(`  ${dim('数据')}   data/codex-reset.db`);
  console.log(
    `  ${dim('参数')}   每 ${config.intervalSec}s 轮询 · 通知${config.notify ? '开' : '关'} · 新鲜窗口 ${config.freshHours}h${
      fetchImpl ? ' · fixture 模式' : ''
    }`,
  );
  console.log('');
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${config.port} 已被占用。修改 config.json 里的 port 后重试。\n`);
  } else {
    console.error(`\n  服务启动失败：${err.message}\n`);
  }
  process.exit(1);
});

server.listen(config.port, '127.0.0.1', async () => {
  if (once) {
    banner();
    const result = await poller.pollOnce('cli');
    if (result.ok) {
      console.log(
        `  抓取 ${result.fetched} 条 · 新增 ${result.inserted} 条 · 警报 ${result.alerts} 条 · 通知 ${result.notified} 条 ${dim(`(${result.durationMs}ms)`)}`,
      );
    } else {
      console.error(`  抓取失败：${result.error}`);
    }
    server.close();
    store.close();
    process.exit(result.ok ? 0 : 1);
    return;
  }

  banner();
  if (!noOpen && config.openBrowser) {
    execFile('open', [url], () => {});
  }
  poller.start();
});

process.on('SIGINT', () => {
  console.log('\n  已停止。\n');
  poller.stop();
  server.close();
  store.close();
  process.exit(0);
});
