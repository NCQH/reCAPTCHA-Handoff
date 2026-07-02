// Ghi log vận hành:
//  - deadLetter: khi cổng đổi layout / lỗi cấu trúc -> ghi để dev cập nhật selector (KHÔNG chứa PII).
//  - logResultEncrypted: lưu kết quả (có PII) đã MÃ HOÁ AES-256-GCM, chỉ khi đặt RESULT_LOG_KEY.
//    Mặc định KHÔNG lưu gì (an toàn PII nhất). Giải mã bằng: npm run decrypt-results

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOG_DIR = path.join(__dirname, '..', 'logs');

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

export function deadLetter(entry) {
  ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try { fs.appendFileSync(path.join(LOG_DIR, 'dead-letter.log'), line); } catch {}
}

// Key: hex 64 ký tự (32 byte) hoặc chuỗi bất kỳ (sẽ SHA-256 thành 32 byte).
export function getKey() {
  const raw = process.env.RESULT_LOG_KEY || '';
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

export function logResultEncrypted(obj) {
  const key = getKey();
  if (!key) return false; // không bật -> không lưu PII
  ensureDir();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
  const rec = JSON.stringify({
    ts: new Date().toISOString(),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: enc.toString('base64')
  }) + '\n';
  try { fs.appendFileSync(path.join(LOG_DIR, 'results.enc.jsonl'), rec); } catch {}
  return true;
}
