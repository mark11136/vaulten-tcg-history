const TARGET = 'https://api.github.com/repos/mark11136/vaulten-tcg-history/actions/workflows/daily-history.yml/dispatches';
const RUN_PREFIX = 'https://github.com/mark11136/vaulten-tcg-history/actions/runs/';
const TIMEOUT_MS = 15000;

// Only this fixed target is accepted. The token is a Cloudflare secret binding.
export async function dispatch(env, dependencies = {}) {
  const fetchImpl = dependencies.fetch || fetch;
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;
  const token = env?.GITHUB_DISPATCH_TOKEN;
  if (typeof token !== 'string' || token.length < 20 || token.length > 255 || /\s/.test(token)) {
    throw new Error('GitHub dispatch secret is missing or invalid.');
  }
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(TARGET, {
        method: 'POST', redirect: 'manual', credentials: 'omit',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'User-Agent': 'VaultenTCG-HistoryScheduler/1.0 (+https://vaultentcg.com)',
          'X-GitHub-Api-Version': '2026-03-10'
        },
        body: JSON.stringify({ ref: 'main', inputs: { bootstrap: false, redeploy: false } }),
        signal: controller.signal
      });
    } catch {
      throw new Error(controller.signal.aborted ? 'GitHub dispatch timed out.' : 'GitHub dispatch network request failed.');
    }
    if (response.status !== 200 && response.status !== 204) {
      await response.body?.cancel().catch(() => {});
      throw new Error('GitHub dispatch rejected (HTTP ' + response.status + ').');
    }
    // 204 is the legacy API response. Current 200 replies identify the created run.
    if (response.status === 204) return { accepted: true, httpStatus: 204, runId: null };
    let data;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16384) throw new Error();
          chunks.push(value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      const joined = new Uint8Array(size); let position = 0;
      for (const chunk of chunks) { joined.set(chunk, position); position += chunk.byteLength; }
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(joined));
      if (!Number.isSafeInteger(data.workflow_run_id) || data.workflow_run_id < 1 || data.html_url !== RUN_PREFIX + data.workflow_run_id) throw new Error();
    } catch {
      throw new Error(controller.signal.aborted ? 'GitHub dispatch response timed out.' : 'GitHub dispatch returned an invalid confirmation.');
    }
    return { accepted: true, httpStatus: 200, runId: data.workflow_run_id };
  } finally { clearTimer(timer); }
}

export default {
  // No HTTP request can cause a dispatch, including an authenticated request.
  fetch() { return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }); },
  async scheduled(controller, env) {
    const result = await dispatch(env);
    console.log(JSON.stringify({ event: 'history-workflow-dispatch', scheduledTime: controller.scheduledTime, ...result }));
  }
};
