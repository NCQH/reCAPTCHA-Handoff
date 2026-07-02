// Giải mã logs/results.enc.jsonl. Cần cùng RESULT_LOG_KEY đã dùng khi ghi.
// Dùng: $env:RESULT_LOG_KEY="..."; npm run decrypt-results

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getKey, LOG_DIR } from '../src/audit.js';

const key = getKey();
if (!key) {
  console.error('Chưa đặt RESULT_LOG_KEY.');
  process.exit(1);
}
const file = path.join(LOG_DIR, 'results.enc.jsonl');
if (!fs.existsSync(file)) {
  console.error('Chưa có', file);
  process.exit(1);
}

for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const { ts, iv, tag, data } = JSON.parse(line);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    const pt = Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
    console.log(ts, pt);
  } catch (e) {
    console.error('Không giải mã được 1 dòng (sai key?):', e.message);
  }
}
