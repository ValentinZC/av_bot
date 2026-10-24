import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/bot/store.ts';
import { Dialog } from '../src/bot/dialog.ts';
import { scan, deliver } from '../src/bot/monitor.ts';
import type { Car } from '../src/av-source.ts';
import type { Button } from '../src/bot/telegram.ts';

const car: Car = { id: 1, url: 'https://cars.av.by/audi/a4/1', brandId: 6, modelId: 5810, generationId: null, title: 'Audi A4', year: 2013, mileageKm: 100000, prices: { usd: 12000 }, publishedAt: '2026-10-01T00:00:00Z', renewedAt: null, location: 'Минск', photo: null };

test('subscriptions persist; baseline is silent; raised IDs are not new; failed delivery retries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'av-bot-'));
  let store = new Store(join(directory, 'test.sqlite'));
  try {
    const id = store.add(10, 'Audi', { brandId: 6 });
    store.record(id, [car]);
    assert.equal(store.pending().length, 0);
    store.record(id, [{ ...car, renewedAt: '2026-10-25T00:00:00Z' }, { ...car, id: 2 }]);
    assert.equal(store.pending().length, 1);
    store.close(); store = new Store(join(directory, 'test.sqlite'));
    assert.equal(store.list(10)[0].initialized, true);
    await deliver(store, async () => { throw new Error('offline'); });
    assert.equal(store.pending().length, 1);
    let sent = 0;
    await deliver(store, async () => { sent++; });
    await deliver(store, async () => { sent++; });
    assert.equal(sent, 1);
    store.remove(20, id); assert.equal(store.list(10).length, 1);
    store.toggle(10, id); store.record(id, [{ ...car, id: 3 }]);
    assert.equal(store.pending().length, 0);
    store.remove(10, id); assert.equal(store.list(10).length, 0);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('monitor shares identical searches and never initializes a failed/incomplete baseline', async () => {
  const store = new Store(':memory:');
  try {
    store.add(10, 'Audi', { brandId: 6 }); store.add(20, 'Audi', { brandId: 6 });
    let calls = 0;
    const result = { pages: 1, scanned: 1, pageReports: [{ page: 1, count: 1, total: 1 }], warnings: [], cars: [car] };
    await scan(store, async () => { calls++; return { ...result, warnings: ['incomplete'] }; }, () => {});
    assert.equal(store.list().every((s) => !s.initialized), true);
    await scan(store, async () => { calls++; return result; }, () => {});
    assert.equal(calls, 2);
    assert.equal(store.list().every((s) => s.initialized), true);
    assert.equal(store.pending().length, 0);
    await scan(store, async () => ({ ...result, cars: [car, { ...car, id: 2 }] }), () => {});
    assert.equal(store.pending().length, 2);
  } finally { store.close(); }
});

test('dialog creates a subscription only after confirmation, handles invalid input and stale buttons', async () => {
  const store = new Store(':memory:');
  const messages: { text: string; buttons: Button[][] }[] = [];
  const dialog = new Dialog(store, async (_chat, text, buttons = []) => { messages.push({ text, buttons }); }, async () => ({
    brands: [{ id: 6, label: 'Audi' }], models: [{ id: 5810, label: 'A4' }], generations: [{ id: 11854, label: 'B8' }], selection: {},
  }));
  const press = async (label: string) => {
    const data = messages.at(-1)!.buttons.flat().find((b) => b.text === label)?.callback_data;
    assert.ok(data, `button ${label} missing`);
    await dialog.handle(10, undefined, data);
  };
  try {
    await dialog.handle(10, '/new');
    const old = messages.at(-1)!.buttons[0][0].callback_data;
    await press('Audi'); await press('A4'); await press('Пропустить'); await press('USD');
    const priceButtons = messages.at(-1)!;
    await dialog.handle(10, '-100');
    assert.equal(dialog.draft(10)!.step, 'price');
    await dialog.handle(10, '15000');
    await dialog.handle(10, '2012'); await dialog.handle(10, '2015'); await dialog.handle(10, '200000');
    const confirmation = messages.at(-1)!;
    assert.equal(store.list().length, 0);
    await dialog.handle(10, undefined, old);
    assert.match(messages.at(-1)!.text, /устарела/);
    assert.equal(dialog.draft(10)!.step, 'confirm');
    messages.push(confirmation); await press('Подписаться');
    const sub = store.list(10)[0];
    assert.equal(sub.filters.priceMax, 15000); assert.equal(sub.filters.mileageMax, 200000);
    assert.equal(sub.initialized, false);
    await dialog.handle(10, undefined, confirmation.buttons[0][0].callback_data);
    assert.equal(store.list().length, 1);
    await dialog.handle(10, '/new'); await press('Отмена');
    assert.equal(dialog.draft(10), null);
    assert.ok(priceButtons.text.includes('Максимальная цена'));
  } finally { store.close(); }
});
