import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n+/g, ' ');
}

export async function notifyMac({ title, subtitle = '', message = '', sound = 'Glass' }) {
  const parts = [`display notification "${escapeAppleScript(message).slice(0, 220)}"`];
  parts.push(`with title "${escapeAppleScript(title)}"`);
  if (subtitle) parts.push(`subtitle "${escapeAppleScript(subtitle)}"`);
  if (sound) parts.push(`sound name "${escapeAppleScript(sound)}"`);

  const script = parts.join(' ');
  await run('osascript', ['-e', script]);
}

export async function playSound(file = '/System/Library/Sounds/Glass.aiff') {
  try {
    await run('afplay', [file], { timeout: 5000 });
  } catch {
    // best effort only
  }
}
