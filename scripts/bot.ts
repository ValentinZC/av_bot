import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Store } from '../src/bot/store.ts';
import { Telegram } from '../src/bot/telegram.ts';
import type { Update } from '../src/bot/telegram.ts';
import { Dialog } from '../src/bot/dialog.ts';
import { carText, deliver, scan } from '../src/bot/monitor.ts';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || !/^\d+:[\w-]+$/.test(token)) {
  console.error('Укажите TELEGRAM_BOT_TOKEN в .env (токен от BotFather).');
  process.exit(1);
}
const interval = Number(process.env.POLL_INTERVAL_SECONDS ?? 300);
if (!Number.isFinite(interval) || interval < 60) throw new Error('POLL_INTERVAL_SECONDS должен быть не меньше 60');
const owner = process.env.TELEGRAM_ALLOWED_USER_ID ? Number(process.env.TELEGRAM_ALLOWED_USER_ID) : null;
if (owner !== null && (!Number.isSafeInteger(owner) || owner <= 0)) throw new Error('Некорректный TELEGRAM_ALLOWED_USER_ID');
const path = process.env.DATABASE_PATH ?? 'data/bot.sqlite';
await mkdir(dirname(path), { recursive: true });
const store = new Store(path);
const telegram = new Telegram(token);
const dialog = new Dialog(store, (chat, text, buttons) => telegram.send(chat, text, buttons));
let running = true;
process.once('SIGINT', () => { running = false; });
process.once('SIGTERM', () => { running = false; });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function monitor() {
  while (running) {
    await scan(store);
    await deliver(store, async (chat, car) => {
      // Text plus link previews avoids losing alerts when photo delivery fails.
      await telegram.send(chat, carText(car));
      await sleep(1100);
    });
    const until = Date.now() + interval * 1000;
    while (running && Date.now() < until) await sleep(1000);
  }
}
async function polling() {
  while (running) {
    try {
      const offset = Number(store.state('telegram-offset') ?? 0);
      const updates = await telegram.call<Update[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        if (!running) break;
        const callback = update.callback_query;
        const chat = update.message?.chat ?? callback?.message?.chat;
        if (callback) await telegram.call('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
        if (chat?.type === 'private' && (owner === null || owner === chat.id)) {
          try { await dialog.handle(chat.id, update.message?.text, callback?.data); }
          catch {
            console.error('Ошибка обработки диалога.');
            await telegram.send(chat.id, 'Не удалось выполнить действие. Повторите ввод или используйте /new, чтобы начать заново.').catch(() => {});
          }
        }
        store.save('telegram-offset', String(update.update_id + 1));
      }
    } catch { console.error('Telegram недоступен; повтор через 5 секунд.'); await sleep(5000); }
  }
}
try {
  const me = await telegram.call<{ username: string }>('getMe', {});
  const webhook = await telegram.call<{ url: string }>('getWebhookInfo', {});
  if (webhook.url) throw new Error('У бота установлен webhook. Используйте отдельного бота для этого запуска.');
  console.log(`Бот @${me.username} запущен. Проверка объявлений каждые ${interval} секунд.`);
  await Promise.all([polling(), monitor()]);
} catch (error) {
  running = false;
  console.error(error instanceof Error ? error.message : 'Ошибка запуска');
  process.exitCode = 1;
} finally { store.close(); }
