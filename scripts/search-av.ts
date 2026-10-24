import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { buildSearchUrl, matches, parsePage, searchCars, validateFilters } from '../src/av-source.ts';

try {
  const { values } = parseArgs({ options: {
    html: { type: 'string' }, filters: { type: 'string' }, url: { type: 'string' },
  } });
  const filters = validateFilters(values.filters ? JSON.parse(await readFile(values.filters, 'utf8')) : {});
  if (!values.html && !values.url && filters.brandId === undefined) {
    throw new Error('Укажите --filters с brandId или --url, чтобы не обходить весь сайт.');
  }
  const parsed = values.html ? parsePage(await readFile(values.html, 'utf8')) : null;
  const result = parsed ? {
    mode: 'saved-page', complete: parsed.page === 1 && parsed.nextUrl === null,
    page: parsed.page, pageCount: parsed.pageCount, total: parsed.total, nextUrl: parsed.nextUrl,
    scanned: parsed.cars.length, cars: parsed.cars.filter((car) => matches(car, filters)), catalog: parsed.catalog,
  } : { mode: 'live', filters, sourceUrl: values.url ?? buildSearchUrl(filters),
    ...(await searchCars(values.url ?? buildSearchUrl(filters), filters)) };
  const directory = `artifacts/search-${Date.now()}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, mode: result.mode, scanned: result.scanned, matched: result.cars.length,
    ...('warnings' in result ? { warnings: result.warnings } : {}),
    ...(parsed ? { page: parsed.page, pageCount: parsed.pageCount, note: 'Обработана только сохранённая страница' } : {}) }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
