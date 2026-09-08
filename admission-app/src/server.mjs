import http from 'node:http';
import { evaluateWorkflowRun, verifyWebhook } from './admission.mjs';
import { installationToken, publishCheck, verifyCurrentPullRequest } from './github.mjs';

const required = ['APP_ID', 'PRIVATE_KEY', 'WEBHOOK_SECRET', 'REPOSITORY', 'REPOSITORY_ID'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);
const privateKey = process.env.PRIVATE_KEY.replaceAll('\\n', '\n');

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200); return res.end('ok\n'); }
  if (req.method !== 'POST' || req.url !== '/webhook') { res.writeHead(404); return res.end(); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (!verifyWebhook(raw, req.headers['x-hub-signature-256'], process.env.WEBHOOK_SECRET)) { res.writeHead(401); return res.end('invalid signature'); }
  if (req.headers['x-github-event'] !== 'workflow_run') { res.writeHead(202); return res.end('ignored'); }
  try {
    const payload = JSON.parse(raw);
    const initial = evaluateWorkflowRun(payload, process.env.REPOSITORY);
    if (!initial.admitted) { res.writeHead(202); return res.end(initial.reason); }
    const token = await installationToken(process.env.APP_ID, privateKey, payload.installation.id);
    const verified = await verifyCurrentPullRequest(token, process.env.REPOSITORY, initial);
    await publishCheck(token, process.env.REPOSITORY, verified);
    res.writeHead(202); res.end('admitted');
  } catch (error) {
    console.error(error);
    res.writeHead(500); res.end('admission failed');
  }
}).listen(Number(process.env.PORT || 3000));
