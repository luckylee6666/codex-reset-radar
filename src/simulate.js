import { loadConfig } from './config.js';

const sample =
  process.argv.slice(2).join(' ').trim() ||
  "We've reset Codex rate limits for everyone. Go build something great!";

const config = loadConfig();
const url = `http://127.0.0.1:${config.port}/api/simulate`;

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: sample }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  console.log(`模拟推文已注入：${sample}`);
  console.log(
    `检测结果：${data.detection.isReset ? '触发重置警报' : '未触发'}（得分 ${data.detection.score}）`,
  );
  for (const signal of data.detection.signals) {
    console.log(`  · [${signal.weight > 0 ? '+' : ''}${signal.weight}] ${signal.label}：${signal.match}`);
  }
  console.log(`系统通知已发送 ${data.notified} 条`);
} catch (err) {
  console.error(`注入失败：${err.message}`);
  console.error('请先运行 pnpm start（或 node src/main.js）启动服务。');
  process.exit(1);
}
