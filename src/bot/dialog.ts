import { randomBytes } from 'node:crypto';
import { getCatalog, validateFilters } from '../av-source.ts';
import type { Filters } from '../av-source.ts';
import type { Button } from './telegram.ts';
import type { Store } from './store.ts';

type Step = 'brand' | 'model' | 'generation' | 'currency' | 'price' | 'yearFrom' | 'yearTo' | 'mileage' | 'confirm';
interface Draft { nonce: string; step: Step; filters: Filters; labels: Record<string, string>; options: {id: number; label: string}[]; page: number }
const steps: Step[] = ['brand', 'model', 'generation', 'currency', 'price', 'yearFrom', 'yearTo', 'mileage', 'confirm'];
const prompts: Record<Step, string> = { brand: 'Выберите марку:', model: 'Выберите модель:', generation: 'Выберите поколение:', currency: 'В какой валюте задавать цену?', price: 'Максимальная цена? Введите число или пропустите.', yearFrom: 'Год выпуска от? Введите год или пропустите.', yearTo: 'Год выпуска до? Введите год или пропустите.', mileage: 'Максимальный пробег в километрах? Введите число или пропустите.', confirm: 'Проверьте подписку:' };
const menu: Button[][] = [[{ text: 'Создать подписку', callback_data: 'new' }], [{ text: 'Мои подписки', callback_data: 'list' }]];
const button = (text: string, callback_data: string): Button => ({ text, callback_data });
export function summary(f: Filters, labels: Record<string, string>) {
  return [labels.brand, labels.model, labels.generation,
    f.priceMax === undefined ? 'Любая цена' : `Цена до ${f.priceMax} ${f.currency?.toUpperCase()}`,
    `Год: ${f.yearFrom ?? 'любой'} — ${f.yearTo ?? 'любой'}`,
    f.mileageMax === undefined ? 'Любой пробег' : `Пробег до ${f.mileageMax} км`].filter(Boolean).join('\n');
}
export class Dialog {
  store: Store;
  send: (chat: number, text: string, buttons?: Button[][]) => Promise<unknown>;
  catalog: typeof getCatalog;
  constructor(store: Store, send: Dialog['send'], catalog = getCatalog) { this.store = store; this.send = send; this.catalog = catalog; }
  draft(chat: number): Draft | null { return JSON.parse(this.store.state(`draft:${chat}`) ?? 'null'); }
  save(chat: number, draft: Draft | null) { this.store.save(`draft:${chat}`, JSON.stringify(draft)); }
  async show(chat: number, draft: Draft) {
    if (['brand', 'model', 'generation'].includes(draft.step)) {
      const f = draft.filters;
      const catalog = await this.catalog(draft.step === 'brand' ? {} : draft.step === 'model' ? { brandId: f.brandId! } : { brandId: f.brandId!, modelId: f.modelId! });
      draft.options = draft.step === 'brand' ? catalog.brands : draft.step === 'model' ? catalog.models : catalog.generations;
    }
    draft.nonce = randomBytes(5).toString('hex');
    const cb = (value: string) => `d:${draft.nonce}:${value}`;
    const buttons: Button[][] = [];
    if (['brand', 'model', 'generation'].includes(draft.step)) {
      const start = draft.page * 12;
      for (const option of draft.options.slice(start, start + 12)) buttons.push([button(option.label, cb(`pick:${option.id}`))]);
      const navigation: Button[] = [];
      if (draft.page > 0) navigation.push(button('←', cb('prev')));
      if (start + 12 < draft.options.length) navigation.push(button('→', cb('next')));
      if (navigation.length) buttons.push(navigation);
    }
    if (draft.step === 'currency') buttons.push([button('USD', cb('usd')), button('BYN', cb('byn'))]);
    if (['generation', 'price', 'yearFrom', 'yearTo', 'mileage'].includes(draft.step)) buttons.push([button('Пропустить', cb('skip'))]);
    if (draft.step === 'confirm') buttons.push([button('Подписаться', cb('confirm'))]);
    if (draft.step !== 'brand') buttons.push([button('Назад', cb('back'))]);
    buttons.push([button('Отмена', 'cancel')]);
    this.save(chat, draft);
    await this.send(chat, prompts[draft.step] + (draft.step === 'confirm' ? '\n\n' + summary(draft.filters, draft.labels) + '\n\nПервый успешный обход запомнит текущие предложения без рассылки.' : ''), buttons);
  }
  async list(chat: number) {
    const subscriptions = this.store.list(chat);
    if (!subscriptions.length) return this.send(chat, 'Подписок пока нет.', menu);
    for (const sub of subscriptions) await this.send(chat, `№${sub.id} · ${sub.active ? (sub.initialized ? 'Активна' : 'Ожидает первого обхода') : 'Пауза'}\n${sub.title}`, [[button(sub.active ? 'Приостановить' : 'Возобновить', `toggle:${sub.id}`), button('Удалить', `remove:${sub.id}`)]]);
    await this.send(chat, 'Управление подписками', menu);
  }
  async handle(chat: number, text?: string, data?: string) {
    if (data === 'cancel' || text === '/cancel' || text === '/start') {
      this.save(chat, null); return this.send(chat, 'Настройте подписку на новые объявления av.by.', menu);
    }
    if (data === 'list' || text === '/subscriptions') return this.list(chat);
    if (data?.startsWith('toggle:') || data?.startsWith('remove:')) {
      const [action, id] = data.split(':');
      if (action === 'toggle') this.store.toggle(chat, Number(id)); else this.store.remove(chat, Number(id));
      return this.list(chat);
    }
    if (data === 'new' || text === '/new') {
      if (this.store.list(chat).length >= 10) return this.send(chat, 'Лимит — 10 подписок. Удалите ненужную.', menu);
      return this.show(chat, { nonce: '', step: 'brand', filters: {}, labels: {}, options: [], page: 0 });
    }
    const draft = this.draft(chat);
    if (!draft) return this.send(chat, 'Нажмите «Создать подписку».', menu);
    let action = '';
    if (data) {
      const [prefix, nonce, ...rest] = data.split(':');
      if (prefix !== 'd' || nonce !== draft.nonce) return this.send(chat, 'Эта кнопка устарела. Используйте последнее сообщение.');
      action = rest.join(':');
    }
    const index = steps.indexOf(draft.step);
    if (action === 'back') {
      draft.step = steps[Math.max(0, index - 1)]; draft.page = 0;
      return this.show(chat, draft);
    }
    if (action === 'prev' || action === 'next') {
      draft.page = Math.max(0, Math.min(Math.ceil(draft.options.length / 12) - 1, draft.page + (action === 'next' ? 1 : -1)));
      return this.show(chat, draft);
    }
    if (['brand', 'model', 'generation'].includes(draft.step)) {
      const choice = draft.options.find((o) => action === `pick:${o.id}`);
      if (!choice && !(action === 'skip' && draft.step === 'generation')) return this.send(chat, 'Выберите вариант кнопкой.');
      const key = `${draft.step}Id` as 'brandId' | 'modelId' | 'generationId';
      if (choice) { draft.filters[key] = choice.id; draft.labels[draft.step] = choice.label; }
      else { delete draft.filters[key]; delete draft.labels[draft.step]; }
      if (draft.step === 'brand') { delete draft.filters.modelId; delete draft.labels.model; }
      if (draft.step !== 'generation') { delete draft.filters.generationId; delete draft.labels.generation; }
    } else if (draft.step === 'currency') {
      if (action !== 'usd' && action !== 'byn') return this.send(chat, 'Выберите USD или BYN кнопкой.');
      draft.filters.currency = action;
    } else if (draft.step === 'confirm') {
      if (action !== 'confirm') return this.send(chat, 'Нажмите «Подписаться» или «Назад».');
      validateFilters(draft.filters);
      const id = this.store.add(chat, summary(draft.filters, draft.labels), draft.filters);
      this.save(chat, null);
      return this.send(chat, `Подписка №${id} сохранена. После первого успешного обхода буду присылать новые совпадения.`, menu);
    } else {
      const key = ({ price: 'priceMax', yearFrom: 'yearFrom', yearTo: 'yearTo', mileage: 'mileageMax' } as const)[draft.step as 'price' | 'yearFrom' | 'yearTo' | 'mileage'];
      if (action === 'skip') delete draft.filters[key];
      else {
        const input = (text ?? '').replace(/\s/g, '');
        const value = Number(input);
        if (!/^\d+$/.test(input) || !Number.isSafeInteger(value) || value < 0 || (draft.step.startsWith('year') && (value < 1900 || value > new Date().getFullYear() + 1))) return this.send(chat, 'Введите корректное целое число без валюты или единиц измерения.');
        if (key === 'yearTo' && draft.filters.yearFrom !== undefined && value < draft.filters.yearFrom) return this.send(chat, 'Год «до» должен быть не меньше года «от».');
        draft.filters[key] = value;
        if (key === 'yearFrom' && draft.filters.yearTo !== undefined && value > draft.filters.yearTo) delete draft.filters.yearTo;
      }
    }
    draft.step = steps[index + 1]; draft.page = 0;
    return this.show(chat, draft);
  }
}
