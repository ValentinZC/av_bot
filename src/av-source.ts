type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Изменилась структура JSON av.by: ожидался объект');
  return value as Obj;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Изменилась структура JSON av.by: ожидался массив');
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Некорректное число в JSON av.by');
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Некорректная строка в JSON av.by');
  return value;
}
export function sourceUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== 'https://cars.av.by' || url.username || url.password) throw new Error('Ожидается HTTPS URL cars.av.by');
  return url;
}

export interface Car {
  id: number; url: string; brandId: number; modelId: number; generationId: number | null;
  title: string; year: number; mileageKm: number | null;
  prices: Partial<Record<'usd' | 'byn', number>>;
  publishedAt: string; renewedAt: string | null; location: string; photo: string | null;
}
export interface Filters {
  brandId?: number; modelId?: number; generationId?: number;
  yearFrom?: number; yearTo?: number; mileageMax?: number;
  priceMin?: number; priceMax?: number; currency?: 'usd' | 'byn';
}
export function validateFilters(value: unknown): Filters {
  const input = object(value);
  const allowed = ['brandId', 'modelId', 'generationId', 'yearFrom', 'yearTo', 'mileageMax', 'priceMin', 'priceMax', 'currency'];
  for (const [key, val] of Object.entries(input)) {
    if (!allowed.includes(key)) throw new Error(`Неизвестный фильтр: ${key}`);
    if (key === 'currency') {
      if (val !== 'usd' && val !== 'byn') throw new Error('Валюта: usd или byn');
    } else number(val);
  }
  const f = input as Filters;
  for (const key of ['brandId', 'modelId', 'generationId', 'yearFrom', 'yearTo', 'mileageMax'] as const) {
    const val = f[key];
    if (val !== undefined && (!Number.isSafeInteger(val) || (key !== 'mileageMax' && val === 0))) {
      throw new Error(`Некорректное целое значение: ${key}`);
    }
  }
  if (f.modelId !== undefined && f.brandId === undefined) throw new Error('Для модели нужна марка');
  if (f.generationId !== undefined && f.modelId === undefined) throw new Error('Для поколения нужна модель');
  for (const [min, max] of [[f.yearFrom, f.yearTo], [f.priceMin, f.priceMax]]) {
    if (min !== undefined && max !== undefined && min > max) throw new Error('Начало диапазона больше конца');
  }
  if ((f.priceMin !== undefined || f.priceMax !== undefined) && !f.currency) throw new Error('Для фильтра цены укажите currency');
  return f;
}

// Only category parameters are sent to av.by; numeric limits remain local.
export function buildSearchUrl(filters: Filters): string {
  const f = validateFilters(filters);
  const url = new URL('https://cars.av.by/filter');
  for (const [key, name] of [['brandId', 'brand'], ['modelId', 'model'], ['generationId', 'generation']] as const) {
    if (f[key] !== undefined) url.searchParams.set(`brands[0][${name}]`, String(f[key]));
  }
  return url.href;
}

export function matches(car: Car, f: Filters): boolean {
  for (const key of ['brandId', 'modelId', 'generationId'] as const) {
    if (f[key] !== undefined && car[key] !== f[key]) return false;
  }
  if (f.yearFrom !== undefined && car.year < f.yearFrom) return false;
  if (f.yearTo !== undefined && car.year > f.yearTo) return false;
  if (f.mileageMax !== undefined && (car.mileageKm === null || car.mileageKm > f.mileageMax)) return false;
  if (f.priceMin !== undefined || f.priceMax !== undefined) {
    const price = f.currency ? car.prices[f.currency] : undefined;
    if (price === undefined || (f.priceMin !== undefined && price < f.priceMin) || (f.priceMax !== undefined && price > f.priceMax)) return false;
  }
  return true;
}

function parseCar(value: unknown): Car {
  const a = object(value), meta = object(a.metadata);
  const props = new Map(array(a.properties).map((p) => { const x = object(p); return [string(x.name), x.value]; }));
  const prices: Car['prices'] = {};
  const rawPrice = object(a.price);
  for (const currency of ['usd', 'byn'] as const) {
    if (rawPrice[currency] != null) prices[currency] = number(object(rawPrice[currency]).amount);
  }
  const photos = array(a.photos).map(object);
  const photo = photos.find((p) => p.main === true) ?? photos[0];
  const publishedAt = string(a.publishedAt);
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('Некорректная дата публикации');
  return {
    id: number(a.id), url: sourceUrl(string(a.publicUrl)).href,
    brandId: number(meta.brandId), modelId: number(meta.modelId),
    generationId: meta.generationId == null ? null : number(meta.generationId),
    title: ['brand', 'model', 'generation'].map((key) => props.get(key)).filter((v) => typeof v === 'string').join(' '),
    year: number(a.year), mileageKm: props.has('mileage_km') ? number(props.get('mileage_km')) : null,
    prices, publishedAt, renewedAt: a.renewedAt == null ? null : string(a.renewedAt),
    location: string(a.locationName), photo: photo ? string(object(photo.medium).url) : null,
  };
}

export function parsePage(html: string) {
  const script = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .find((m) => /\bid\s*=\s*(["'])__NEXT_DATA__\1/.test(m[1]));
  if (!script) throw new Error('Нет __NEXT_DATA__: ответ не является ожидаемой выдачей av.by');
  const state = object(object(object(JSON.parse(script[2])).props).initialState);
  const filter = object(object(state.filter).main);
  const cars = array(filter.adverts).map(parseCar);
  const page = number(filter.page), pageCount = number(filter.pageCount), total = number(filter.count);
  if (total > 0 && cars.length === 0) throw new Error('Неполная выдача: нет объявлений при ненулевом count');
  let nextUrl: string | null = null;
  if (filter.nextPage != null) {
    const nextPage = number(filter.nextPage);
    if (nextPage <= page || nextPage > pageCount) throw new Error('Некорректная пагинация');
    const next = new URL('https://cars.av.by/filter');
    next.search = string(filter.initialValue);
    next.searchParams.set('page', String(nextPage));
    nextUrl = next.href;
  } else if (page < pageCount) throw new Error('Отсутствует следующая страница');
  const map = object(object(object(state.properties).main).propertyMap);
  const brands = object(map.brands);
  const selection = array(brands.value ?? [])[0];
  const selected = selection ? object(selection) : {};
  const options = (key: string) => {
    const field = selected[key] ?? array(brands.nested).map(object).find((p) => p.name === key);
    return field ? array(object(field).options).map((v) => { const o = object(v); return { id: number(o.id), label: string(o.label) }; }) : [];
  };
  return { cars, page, pageCount, total, nextUrl, catalog: {
    brands: options('brand'), models: options('model'), generations: options('generation'),
    // Model/generation options apply to the current selected brand/model only.
    selection: Object.fromEntries(['brand', 'model', 'generation'].map((key) => {
      const value = selected[key] ? object(selected[key]).value : null;
      if (!value) return [key, null];
      const item = object(value);
      return [key, { id: number(item.id), label: string(item.label) }];
    })),
  } };
}

export async function fetchPage(url: string) {
  const response = await fetch(sourceUrl(url), {
    headers: { accept: 'text/html', 'user-agent': 'AvSubscriptionResearch/0.1' },
    redirect: 'error', signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`av.by: HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('av.by: ожидался HTML');
  return parsePage(await response.text());
}

export async function getCatalog(filters: Filters = {}, load = fetchPage) {
  const f = validateFilters(filters);
  const page = await load(buildSearchUrl(f));
  for (const [key, name] of [['brandId', 'brand'], ['modelId', 'model'], ['generationId', 'generation']] as const) {
    if (f[key] !== undefined && page.catalog.selection[name]?.id !== f[key]) {
      throw new Error(`av.by не применил выбор: ${name}`);
    }
  }
  return page.catalog;
}

export async function searchCars(url: string, filters: Filters, load = fetchPage) {
  validateFilters(filters);
  const seen = new Set<string>(), cars = new Map<number, Car>();
  const pageReports: { page: number; count: number; total: number }[] = [];
  let next: string | null = sourceUrl(url).href;
  let previousPage = 0;
  while (next) {
    if (seen.has(next) || seen.size >= 100) throw new Error('Обход страниц остановлен: цикл или лимит 100 страниц; результат неполный');
    seen.add(next);
    const result = await load(next);
    if (result.page <= previousPage) throw new Error('av.by вернул повторную страницу');
    previousPage = result.page;
    pageReports.push({ page: result.page, count: result.cars.length, total: result.total });
    for (const car of result.cars) cars.set(car.id, car);
    next = result.nextUrl;
    if (next && load === fetchPage) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { pages: seen.size, scanned: cars.size, pageReports,
    // A warning is evidence of possible incompleteness, not proof of missing ads.
    warnings: pageReports.some((p) => p.total !== pageReports[0].total) || cars.size !== pageReports[0]?.total
      ? ['Количество объявлений изменилось либо уникальных ID меньше/больше заявленного total; повторите обход.'] : [],
    cars: [...cars.values()].filter((car) => matches(car, filters)) };
}
