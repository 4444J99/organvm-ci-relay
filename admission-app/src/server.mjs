import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { evaluateWorkflowRun, verifyWebhook } from './admission.mjs';
import { installationToken, publishCheck, startCheck, verifyCurrentPullRequest } from './github.mjs';

export function createAdmissionServer(env = process.env, dependencies = {}) {
  const required = ['APP_ID', 'PRIVATE_KEY', 'WEBHOOK_SECRET', 'REPOSITORY', 'REPOSITORY_ID', 'INSTALLATION_ID'];
  for (const key of required) if (!env[key]) throw new Error(`${key} is required`);
  for (const key of ['APP_ID', 'REPOSITORY_ID', 'INSTALLATION_ID']) {
    if (!/^[1-9][0-9]*$/.test(env[key])) throw new Error(`${key} must be a positive integer`);
  }
  const privateKey = env.PRIVATE_KEY.replaceAll('\\n', '\n');
  const getToken = dependencies.installationToken ?? installationToken;
  const verify = dependencies.verifyCurrentPullRequest ?? verifyCurrentPullRequest;
  const publish = dependencies.publishCheck ?? publishCheck;
  const reserveCheck = dependencies.startCheck ?? startCheck;
  const readTimeout = dependencies.readTimeout ?? 2000;
  const maximumBytes = 1024 * 1024;
  return http.createServer({ requestTimeout: readTimeout, headersTimeout: readTimeout }, async (req, res) => {
    const reply = (status, message) => { if (!res.headersSent && !res.destroyed) { res.writeHead(status); res.end(message); } };
    if (req.method === 'GET' && req.url === '/healthz') return reply(200, 'ok\n');
    if (req.method !== 'POST' || req.url !== '/webhook') return reply(404, '');
    const readDeadline = setTimeout(() => { reply(408, 'webhook read timeout'); req.destroy(); }, readTimeout);
    try {
      const declaredLength = Number(req.headers['content-length'] || 0);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maximumBytes) return reply(413, 'payload too large');
      const chunks = [];
      let received = 0;
      for await (const chunk of req) {
        received += chunk.length;
        if (received > maximumBytes) return reply(413, 'payload too large');
        chunks.push(chunk);
      }
      clearTimeout(readDeadline);
      const raw = Buffer.concat(chunks);
      if (!verifyWebhook(raw, req.headers['x-hub-signature-256'], env.WEBHOOK_SECRET)) return reply(401, 'invalid signature');
      if (req.headers['x-github-event'] !== 'workflow_run') return reply(202, 'ignored');
      const payload = JSON.parse(raw);
      const initial = evaluateWorkflowRun(payload, env.REPOSITORY, env.REPOSITORY_ID);
      if (!initial.eligible) return reply(202, 'untrusted or unrelated workflow');
      if (String(payload.installation?.id) !== env.INSTALLATION_ID) return reply(403, 'installation mismatch');
      const token = await getToken(env.APP_ID, privateKey, env.INSTALLATION_ID);
      // GitHub's existing Check Run is durable pending custody. Each delivery owns
      // its check ID; an earlier delayed completion cannot rewrite a newer check.
      const pending = await reserveCheck(token, env.REPOSITORY, initial);
      // Success and failure deliveries both re-read the latest trusted evaluation.
      // A late success webhook cannot resurrect a superseded success.
      const verified = await verify(token, env.REPOSITORY, initial, env.REPOSITORY_ID);
      await publish(token, env.REPOSITORY, { ...verified, checkId: pending.id });
      return reply(202, verified.admitted ? 'admitted' : 'rejected');
    } catch {
      return reply(503, 'admission incomplete; redelivery required');
    } finally {
      clearTimeout(readDeadline);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAdmissionServer().listen(Number(process.env.PORT || 3000));
}
