import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const appId = Number(process.argv[2]);
if (process.argv.length !== 3 || !/^[1-9][0-9]*$/.test(process.argv[2]) || !Number.isSafeInteger(appId)) {
  throw new Error('Usage: node enforcement/render-config.mjs POSITIVE_NUMERIC_APP_ID');
}
if (appId === 15368) {
  throw new Error('GitHub Actions App ID 15368 is a shared producer; a dedicated admission App ID is required.');
}
const payload = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./branch-protection.json', import.meta.url)), 'utf8'));
payload.required_status_checks.checks[0].app_id = appId;
process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
