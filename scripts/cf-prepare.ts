import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const file = new URL('../cloudflare/probe/.probe-secret.json', import.meta.url);
try {
  await writeFile(file, JSON.stringify({ PROBE_TOKEN: randomBytes(32).toString('hex') }), { flag: 'wx', mode: 0o600 });
  console.log('Отдельный ключ тестового Worker создан. Токен Telegram не используется.');
} catch (error) {
  if ((error as { code?: string }).code !== 'EEXIST') throw error;
  console.log('Ключ тестового Worker уже существует, сохранён без изменений.');
}
