import { buildSearchUrl, searchCars } from '../av-source.ts';
import type { Car } from '../av-source.ts';
import type { Store } from './store.ts';

export function carText(car: Car) {
  return `${car.title}\n${car.year} г. · ${car.mileageKm === null ? 'Пробег не указан' : car.mileageKm + ' км'}\n${car.prices.usd ?? '—'} USD · ${car.prices.byn ?? '—'} BYN\n${car.location}\n${car.url}`;
}
export async function scan(store: Store, search = searchCars, log: (message: string) => void = console.error) {
  // Identical filters share one scan per cycle; failures do not change baselines.
  const groups = new Map<string, ReturnType<Store['list']>>();
  for (const sub of store.list().filter((s) => s.active)) {
    const key = JSON.stringify(Object.entries(sub.filters).sort(([a], [b]) => a.localeCompare(b)));
    groups.set(key, [...(groups.get(key) ?? []), sub]);
  }
  for (const subscriptions of groups.values()) {
    try {
      const filters = subscriptions[0].filters;
      const result = await search(buildSearchUrl(filters), filters);
      if (result.warnings.length) throw new Error('Выдача изменилась во время обхода');
      for (const sub of subscriptions) store.record(sub.id, result.cars);
    } catch {
      log(`Не удалось проверить подписки ${subscriptions.map((s) => s.id).join(', ')}; повтор в следующем цикле.`);
    }
  }
}
export async function deliver(store: Store, send: (chat: number, car: Car) => Promise<unknown>) {
  const failedChats = new Set<number>();
  for (const item of store.pending()) {
    if (failedChats.has(item.chat)) continue;
    // Recheck ownership/existence after any awaited delivery.
    if (!store.list(item.chat).some((s) => s.id === item.subscription && s.active)) continue;
    try {
      await send(item.chat, item.car);
      store.delivered(item.subscription, item.advert);
    } catch {
      failedChats.add(item.chat);
      console.error(`Доставка подписки ${item.subscription} отложена.`);
    }
  }
}
