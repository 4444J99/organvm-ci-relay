import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const appId = Number(process.argv[2]);
if (process.argv.length !== 3 || !/^[1-9][0-9]*$/.test(process.argv[2]) || !Number.isSafeInteger(appId)) {
  throw new Error('Usage: node enforcement/render-config.mjs POSITIVE_NUMERIC_APP_ID');
}
const payload = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./branch-protection.json', import.meta.url)), 'utf8'));
payload.required_status_checks.checks[0].app_id = appId;
process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
