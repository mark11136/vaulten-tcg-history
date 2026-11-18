import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker, { dispatch } from '../worker.mjs';

const env = { GITHUB_DISPATCH_TOKEN: 'synthetic-test-token-not-a-real-secret' };
const target = 'https://api.github.com/repos/mark11136/vaulten-tcg-history/actions/workflows/daily-history.yml/dispatches';
const confirmed = () => Response.json({ workflow_run_id: 123, html_url: 'https://github.com/mark11136/vaulten-tcg-history/actions/runs/123' });

test('fixed endpoint, main branch, ordinary source refresh and token only in authorization', async () => {
  let request;
  const result = await dispatch(env, { fetch: async (url, options) => { request = { url, options }; return confirmed(); } });
  assert.equal(request.url, target);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'manual');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.headers.Authorization, 'Bearer ' + env.GITHUB_DISPATCH_TOKEN);
  assert.deepEqual(JSON.parse(request.options.body), { ref: 'main', inputs: { bootstrap: false, redeploy: false } });
  assert.equal(request.options.body.includes(env.GITHUB_DISPATCH_TOKEN), false);
  assert.deepEqual(result, { accepted: true, httpStatus: 200, runId: 123 });
});
test('legacy 204 is accepted without an invented run ID', async () => {
  assert.deepEqual(await dispatch(env, { fetch: async () => new Response(null, { status: 204 }) }), { accepted: true, httpStatus: 204, runId: null });
});
test('no environment override can change the fixed repo or branch', async () => {
  await dispatch({ ...env, TARGET: 'https://attacker.invalid', REPOSITORY: 'other/repo', BRANCH: 'other' }, { fetch: async (url, options) => {
    assert.equal(url, target); assert.equal(JSON.parse(options.body).ref, 'main'); return confirmed();
  } });
});
test('missing and malformed secret fail before network', async () => {
  for (const value of [undefined, '', 'short', 'x'.repeat(256), 'x'.repeat(30) + '\n']) {
    await assert.rejects(dispatch({ GITHUB_DISPATCH_TOKEN: value }, { fetch: () => { throw new Error('must not fetch'); } }), /secret is missing or invalid/);
  }
});
test('HTTP failures and redirects are rejected without leaking response content', async () => {
  for (const status of [301, 302, 400, 401, 403, 404, 429, 500, 502]) {
    await assert.rejects(dispatch(env, { fetch: async () => new Response(env.GITHUB_DISPATCH_TOKEN, { status }) }), error => error.message === 'GitHub dispatch rejected (HTTP ' + status + ').');
  }
});
test('network failure message cannot expose token or upstream exception', async () => {
  await assert.rejects(dispatch(env, { fetch: async () => { throw new Error(env.GITHUB_DISPATCH_TOKEN); } }), error => error.message === 'GitHub dispatch network request failed.');
});
test('timeout aborts the pending request and clears its timer', async () => {
  let fire; let cleared = false;
  const promise = dispatch(env, { setTimeout: (callback, ms) => { assert.equal(ms, 15000); fire = callback; return 5; }, clearTimeout: id => { assert.equal(id, 5); cleared = true; }, fetch: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('internal failure')), { once: true })) });
  fire(); await assert.rejects(promise, /timed out/); assert.equal(cleared, true);
});
test('200 confirmation must identify this exact repository run', async () => {
  for (const body of ['not json', JSON.stringify({ workflow_run_id: 123, html_url: 'https://attacker.invalid/123' }), JSON.stringify({ workflow_run_id: 0, html_url: '' }), 'x'.repeat(16385)]) {
    await assert.rejects(dispatch(env, { fetch: async () => new Response(body, { status: 200 }) }), /invalid confirmation/);
  }
});
test('public HTTP requests never dispatch', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error(); };
  try {
    for (const method of ['GET', 'POST', 'PUT', 'OPTIONS']) {
      const response = worker.fetch(new Request('https://example.invalid/dispatch', { method }), env);
      assert.equal(response.status, 404);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test('scheduled invocation logs only an allowlisted outcome and performs one dispatch', async () => {
  const originalFetch = globalThis.fetch; const originalLog = console.log;
  const logs = []; let calls = 0;
  globalThis.fetch = async () => { calls++; return confirmed(); }; console.log = message => logs.push(JSON.parse(message));
  try { await worker.scheduled({ scheduledTime: 1795000000000 }, env); }
  finally { globalThis.fetch = originalFetch; console.log = originalLog; }
  assert.equal(calls, 1); assert.deepEqual(logs, [{ event: 'history-workflow-dispatch', scheduledTime: 1795000000000, accepted: true, httpStatus: 200, runId: 123 }]);
  assert.equal(JSON.stringify(logs).includes(env.GITHUB_DISPATCH_TOKEN), false);
});
test('four UTC slots, no HTTP route and no embedded credentials', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.triggers.crons, ['13 1,7,13,19 * * *']);
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.equal(config.routes, undefined); assert.equal(config.vars, undefined);
});
