import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getCatalog, parsePage, validateFilters } from '../src/av-source.ts';

try {
  const { values } = parseArgs({ options: {
    brand: { type: 'string' }, model: { type: 'string' }, html: { type: 'string' },
  } });
  const filters = validateFilters({
    ...(values.brand !== undefined ? { brandId: Number(values.brand) } : {}),
    ...(values.model !== undefined ? { modelId: Number(values.model) } : {}),
  });
  if (values.html && (values.brand || values.model)) throw new Error('--html читает существующий выбор; не совмещайте с --brand/--model');
  const catalog = values.html
    ? parsePage(await readFile(values.html, 'utf8')).catalog
    : await getCatalog(filters);
  const directory = `artifacts/catalog-${Date.now()}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/catalog.json`, JSON.stringify(catalog, null, 2));
  console.log(JSON.stringify({ directory, selection: catalog.selection,
    brands: catalog.brands.length, models: catalog.models.length, generations: catalog.generations.length }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
