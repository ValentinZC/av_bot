import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSearchUrl, getCatalog, matches, parsePage, searchCars, validateFilters } from '../src/av-source.ts';

// Reduced real av.by response captured on 2026-10-24.
// Descriptions, seller data and unrelated application state are excluded.
const fixture = JSON.parse(await readFile(new URL('./fixtures/av-page.json', import.meta.url), 'utf8'));
const html = (data: unknown) => `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify(data)}</script>`;

test('extracts real listing fields and preserves publication vs renewal dates', () => {
  const page = parsePage(html(fixture));
  const car = page.cars[0];
  assert.equal(car.id, 142126228);
  assert.equal(car.mileageKm, 235000);
  assert.equal(car.prices.usd, 11500);
  assert.equal(car.year, 2013);
  assert.equal(car.publishedAt, '2026-10-13T19:10:24+0000');
  assert.equal(car.renewedAt, '2026-10-24T14:49:03+0000');
  assert.equal(new URL(page.nextUrl!).searchParams.get('brands[0][model]'), '5810');
  assert.deepEqual(page.catalog.selection.brand, { id: 6, label: 'Audi' });
});

test('filters include boundaries, reject missing mileage and distinguish currencies', () => {
  const car = parsePage(html(fixture)).cars[0];
  assert.equal(matches(car, validateFilters({ priceMax: 11500, currency: 'usd', mileageMax: 235000 })), true);
  assert.equal(matches(car, { priceMax: 11500, currency: 'byn' }), false);
  assert.equal(matches(car, { mileageMax: 200000 }), false);
  assert.equal(matches({ ...car, mileageKm: null }, { mileageMax: 200000 }), false);
  assert.throws(() => validateFilters({ priceMax: 15000 }), /currency/);
  assert.throws(() => validateFilters({ yearFrom: 2020, yearTo: 2010 }), /диапазона/);
  assert.throws(() => validateFilters({ priceMax: -1 }), /число/);
});

test('builds category URL from filters without silently using Audi defaults', () => {
  const url = new URL(buildSearchUrl({ brandId: 8, modelId: 123, currency: 'usd', priceMax: 15000 }));
  assert.equal(url.searchParams.get('brands[0][brand]'), '8');
  assert.equal(url.searchParams.get('brands[0][model]'), '123');
  assert.equal(url.searchParams.size, 2);
  assert.throws(() => validateFilters({ modelId: 5810 }), /марка/);
  assert.throws(() => validateFilters({ brandId: 6, generationId: 11854 }), /модель/);
  assert.throws(() => validateFilters({ brandId: 1.5 }), /целое/);
});

test('catalog detects a server ignoring the requested brand', async () => {
  const page = parsePage(html(fixture));
  assert.deepEqual((await getCatalog({ brandId: 6 }, async () => page)).selection.brand, { id: 6, label: 'Audi' });
  await assert.rejects(getCatalog({ brandId: 8 }, async () => page), /не применил/);
  const unselected = structuredClone(fixture);
  const brands = unselected.props.initialState.properties.main.propertyMap.brands;
  brands.nested = [{ name: 'brand', options: brands.value[0].brand.options }];
  delete brands.value;
  assert.equal(parsePage(html(unselected)).catalog.brands.length, 2);
  assert.equal(parsePage(html(unselected)).catalog.models.length, 0);
});

test('fails on unexpected response and distinguishes an explicit empty result', () => {
  assert.throws(() => parsePage('<h1>Access denied</h1>'), /__NEXT_DATA__/);
  const empty = structuredClone(fixture);
  Object.assign(empty.props.initialState.filter.main, { adverts: [], count: 0, page: 1, pageCount: 0, nextPage: null });
  assert.equal(parsePage(html(empty)).cars.length, 0);
  empty.props.initialState.filter.main.count = 4;
  assert.throws(() => parsePage(html(empty)), /Неполная/);
});

test('follows all pages, deduplicates TOP repeats and fails if a later request fails', async () => {
  const first = parsePage(html(fixture));
  const second = { ...first, page: 2, pageCount: 2, nextUrl: null };
  let calls = 0;
  const result = await searchCars('https://cars.av.by/audi/a4', {}, async () => ++calls === 1 ? first : second);
  assert.equal(result.pages, 2);
  assert.equal(result.scanned, 1);
  calls = 0;
  await assert.rejects(searchCars('https://cars.av.by/audi/a4', {}, async () => {
    if (++calls === 1) return first;
    throw new Error('HTTP 429');
  }), /429/);
  await assert.rejects(searchCars('https://cars.av.by/audi/a4', {}, async () => first), /повторную/);
});
