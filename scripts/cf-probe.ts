import { readFile, mkdir, writeFile } from 'node:fs/promises';

try {
  const input = process.argv[2];
  if (!input) throw new Error('Укажите URL Worker: npm run cf:probe -- https://avby-source-probe.<account>.workers.dev');
  const url = new URL(input);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Ожидается HTTPS-адрес *.workers.dev без пути/параметров.');
  const { PROBE_TOKEN } = JSON.parse(await readFile(new URL('../cloudflare/probe/.probe-secret.json', import.meta.url), 'utf8'));
  if (typeof PROBE_TOKEN !== 'string' || !PROBE_TOKEN) throw new Error('Сначала npm run cf:prepare');
  const results: unknown[] = [];
  const directory = `artifacts/cloudflare-${Date.now()}`;
  await mkdir(directory, { recursive: true });
  // Three first-page samples include cold/warm runs, then check other page sizes.
  for (const page of [1, 1, 1, 2, 3, 4]) {
    const endpoint = new URL(`/probe?page=${page}`, url);
    let record: Record<string, unknown>;
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${PROBE_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(40_000) });
      const raw = await response.text();
      let report: unknown;
      try { report = JSON.parse(raw); } catch { report = { error: 'NON_JSON_RESPONSE', bodyPreview: raw.slice(0, 400) }; }
      record = { at: new Date().toISOString(), requestedPage: page, status: response.status, report };
      results.push(record);
      await writeFile(`${directory}/report.json`, JSON.stringify({ worker: url.origin, cpuVerdict: 'NOT_MEASURED_CHECK_CLOUDFLARE_METRICS', results }, null, 2));
      console.log(JSON.stringify(record));
      if (!response.ok || !(report as { ok?: boolean }).ok) throw new Error('Worker вернул ошибку. Проверьте отчёт и логи Cloudflare.');
    } catch (error) {
      await writeFile(`${directory}/failure.txt`, 'Проверка прервана. Проверьте сетевой доступ, HTTP-статусы и логи Worker.\n');
      console.error(`Неполный отчёт: ${directory}`);
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.log(`Отчёт: ${directory}/report.json. Успех HTTP не подтверждает запас CPU: проверьте метрики Cloudflare.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Ошибка проверки');
  process.exitCode = 1;
}
