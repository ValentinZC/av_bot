import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handle } from '../cloudflare/probe/src/index.ts';

const fixture = await readFile(new URL('./fixtures/av-page.json', import.meta.url), 'utf8');
const html = `<script id="__NEXT_DATA__" type="application/json">${fixture}</script>`;
const request = (path = '/probe?page=1', token = 'test-only') => new Request(`https://probe.example${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
const env = { PROBE_TOKEN: 'test-only' };

test('Worker blocks unauthorized or unconfigured calls before fetching', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error('must not fetch'); };
  assert.equal((await handle(request(), {}, transport)).status, 503);
  assert.equal((await handle(request('/probe', 'wrong'), env, transport)).status, 401);
  assert.equal((await handle(request('/probe?page=100'), env, transport)).status, 400);
  assert.equal((await handle(request('/probe?url=https://example.com'), env, transport)).status, 400);
  assert.equal(calls, 0);
});

test('Worker parses one real-shaped page with existing parser and makes no CPU claim', async () => {
  let calls = 0;
  const transport: typeof fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://cars.av.by');
    assert.equal(url.searchParams.get('brands[0][model]'), '5810');
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(init?.redirect, 'manual');
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  };
  const response = await handle(request(), env, transport);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.parsed, 1);
  assert.deepEqual(result.ids, [142126228]);
  assert.equal(result.cpuMs, null);
  assert.equal(result.matched, 0);
  assert.equal(calls, 1);
});

test('Worker rejects upstream block pages, redirects, oversized HTML and wrong page', async () => {
  for (const response of [
    new Response('blocked', { status: 403 }),
    new Response('', { status: 302, headers: { location: 'https://example.com' } }),
    new Response('<h1>Captcha</h1>', { headers: { 'content-type': 'text/html' } }),
    new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } }),
  ]) {
    assert.equal((await handle(request(), env, async () => response)).status, 502);
  }
  assert.equal((await handle(request('/probe?page=2'), env, async () => new Response(html, { headers: { 'content-type': 'text/html' } }))).status, 502);
});
