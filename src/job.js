// Vòng đời một yêu cầu (state machine, mục 3 của kiến trúc):
// PENDING -> FILLING -> AWAIT_CHECKBOX -> [AWAIT_CHALLENGE] -> TOKEN_READY
//         -> SUBMITTING -> PARSING -> DONE  (hoặc FAILED)
//
// Hỗ trợ 2 kiểu target (xem src/config.js):
//   - submitNavigates=true  : submit điều hướng sang trang kết quả (site demo).
//   - submitNavigates=false : submit chạy AJAX, kết quả inject vào #tcContainer (cổng BHXH thật).

import {
  TARGET, STATES, TOKEN_TIMEOUT_MS, RESULT_TIMEOUT_MS,
  MAX_OPEN_RETRIES, MAX_CAPTCHA_RETRIES
} from './config.js';
import { resetPage, resetCaptcha } from './browser.js';
import { waitForCaptchaFocus, waitForCaptchaToken } from './captcha-handoff.js';
import { deadLetter, logResultEncrypted } from './audit.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lỗi cổng đổi layout (thiếu selector) -> KHÔNG retry, ghi dead-letter.
class LayoutError extends Error {
  constructor(selector) {
    super(`Thiếu selector: ${selector}`);
    this.selector = selector;
  }
}

class CancelledJob extends Error {
  constructor() {
    super('Job đã bị hủy.');
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new CancelledJob();
}

/**
 * Chạy trọn một job.
 * @param {{maso:string, hoten:string, ngaysinh:string}} input
 * @param {(state:string, extra?:object)=>void} emit  callback báo trạng thái ra UI
 * @param {(rect:object|null)=>void} sendFocus  callback gửi vùng crop live-view (rect viewport CSS px) hoặc null=toàn màn hình
 * @param {{signal?:AbortSignal, onPage?:(page:import('playwright').Page)=>void}} options
 */
export async function runJob(input, emit, sendFocus = () => {}, options = {}) {
  const { signal, onPage } = options;
  try {
    // Mở/tái tạo browser (nằm TRONG try để lỗi launch được báo FAILED, không văng ra ngoài)
    throwIfCancelled(signal);
    const page = await resetPage();
    throwIfCancelled(signal);
    onPage?.(page);
    sendFocus(null); // bắt đầu chưa có captcha -> UI không hiện live-view

    // --- FILLING (có retry cho lỗi tạm thời: mạng/timeout) ---
    await openAndFill(page, input, emit, sendFocus, signal);
    throwIfCancelled(signal);

    // --- Vòng giải captcha + submit, có phục hồi khi captcha bị từ chối/hết hạn ---
    let captchaAttempt = 0;
    while (true) {
      throwIfCancelled(signal);
      emit(STATES.AWAIT_CHECKBOX, {
        message: 'Đã điền xong. Mời bạn click "I\'m not a robot" trong ô captcha.'
      });

      const token = await waitForCaptchaToken(page, {
        target: TARGET,
        timeoutMs: TOKEN_TIMEOUT_MS,
        signal,
        onFocus: sendFocus,
        onChallenge: () => emit(STATES.AWAIT_CHALLENGE, {
          message: 'Google yêu cầu giải hình — bạn giải luôn trong live-view nhé.'
        })
      });
      if (!token) {
        sendFocus(null);
        emit(STATES.FAILED, { message: 'Hết thời gian chờ captcha (token không xuất hiện).' });
        return { ok: false, reason: 'TOKEN_TIMEOUT' };
      }

      sendFocus(null); // xong captcha -> trả live-view về toàn màn hình
      emit(STATES.TOKEN_READY, { message: 'Đã có token captcha. Tự động submit…' });

      // --- SUBMITTING: token còn sống, submit ngay ---
      throwIfCancelled(signal);
      emit(STATES.SUBMITTING, { message: 'Đang gửi yêu cầu tra cứu…' });
      await submitForm(page);

      // --- PARSING: chờ kết quả / lỗi rồi bóc tách ---
      throwIfCancelled(signal);
      emit(STATES.PARSING, { message: 'Đang chờ & bóc tách kết quả…' });
      const outcome = await waitForResultOrError(page, signal);

      if (outcome.type === 'error') {
        // Nếu lỗi do captcha (từ chối/hết hạn) và còn lượt -> reset, giải lại.
        if (isCaptchaError(outcome.message) && captchaAttempt < MAX_CAPTCHA_RETRIES) {
          captchaAttempt++;
          await resetCaptcha();
          emit(STATES.AWAIT_CHECKBOX, {
            message: `Captcha bị từ chối/hết hạn — mời click lại (lần ${captchaAttempt + 1}).`
          });
          continue;
        }
        emit(STATES.FAILED, { message: outcome.message || 'Cổng trả về lỗi / không tìm thấy.' });
        return { ok: false, reason: 'PORTAL_ERROR', message: outcome.message };
      }

      throwIfCancelled(signal);
      const result = await parseResult(page);
      logResultEncrypted({ maso: input.maso, result }); // chỉ lưu khi đặt RESULT_LOG_KEY (đã mã hoá)
      emit(STATES.DONE, { message: 'Hoàn tất.', result });
      return { ok: true, result };
    }
  } catch (err) {
    if (err instanceof CancelledJob || signal?.aborted) {
      sendFocus(null);
      return { ok: false, reason: 'CANCELLED' };
    }
    if (err instanceof LayoutError) {
      deadLetter({ type: 'LAYOUT_CHANGED', selector: err.selector, url: TARGET.url, mode: TARGET.mode });
      emit(STATES.FAILED, {
        message: `Cổng có thể đã đổi layout (thiếu: ${err.selector}). Đã ghi dead-letter — cần cập nhật selector trong config.`
      });
      return { ok: false, reason: 'LAYOUT_CHANGED', selector: err.selector };
    }
    emit(STATES.FAILED, { message: `Lỗi: ${err.message}` });
    return { ok: false, reason: err.message };
  }
}

// Mở trang + kiểm tra selector + điền. Retry lỗi tạm thời; LayoutError thì bỏ qua retry.
async function openAndFill(page, input, emit, sendFocus, signal) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_OPEN_RETRIES; attempt++) {
    try {
      throwIfCancelled(signal);
      emit(STATES.FILLING, {
        message: `Đang mở trang (${TARGET.mode})${attempt > 1 ? ` — thử lại lần ${attempt}` : ''}…`
      });
      await page.goto(TARGET.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      throwIfCancelled(signal);
      await assertSelectors(page); // đổi layout -> LayoutError (không retry)
      await page.fill(TARGET.fields.maso, input.maso ?? '');
      await page.fill(TARGET.fields.hoten, input.hoten ?? '');
      await page.fill(TARGET.fields.ngaysinh, input.ngaysinh ?? '');
      await waitForCaptchaFocus(page, { target: TARGET, onFocus: sendFocus, signal });
      throwIfCancelled(signal);
      return;
    } catch (err) {
      if (err instanceof CancelledJob || signal?.aborted) throw err;
      if (err instanceof LayoutError) throw err;
      lastErr = err;
      if (attempt < MAX_OPEN_RETRIES) await sleep(1000);
    }
  }
  throw lastErr;
}

// Kiểm tra các selector cốt lõi còn tồn tại (phát hiện cổng đổi layout).
async function assertSelectors(page) {
  const need = [TARGET.fields.maso, TARGET.fields.hoten, TARGET.fields.ngaysinh, TARGET.submit];
  for (const sel of need) {
    if ((await page.locator(sel).count()) === 0) throw new LayoutError(sel);
  }
}

async function submitForm(page) {
  if (TARGET.submitNavigates) {
    await Promise.all([page.waitForLoadState('domcontentloaded'), page.click(TARGET.submit)]);
  } else {
    await page.click(TARGET.submit); // AJAX, không điều hướng
  }
}

// Lỗi có vẻ do captcha (để quyết định giải lại thay vì báo hỏng).
function isCaptchaError(msg) {
  if (!msg) return false;
  return /captcha|recaptcha|xác thực|xac thuc|mã xác nhận|robot|hết hạn|het han/i.test(msg);
}

// Chờ tới khi có kết quả (#ready có nội dung) hoặc lỗi (#error có text).
async function waitForResultOrError(page, signal) {
  const start = Date.now();
  const errSel = TARGET.result.error;
  const readySel = TARGET.result.ready;

  while (Date.now() - start < RESULT_TIMEOUT_MS) {
    throwIfCancelled(signal);
    if (errSel) {
      const errText = await innerTextOf(page, errSel);
      if (errText) return { type: 'error', message: errText };
    }

    const readyText = await innerTextOf(page, readySel);
    if (readyText && readyText.trim().length > 0) {
      return { type: 'result' };
    }

    await sleep(400);
  }
  throw new Error('Không nhận được kết quả sau khi submit (timeout).');
}

async function parseResult(page) {
  // Target có cấu trúc cố định (demo): bóc từng trường.
  if (TARGET.result.structured) {
    const out = {};
    for (const [key, sel] of Object.entries(TARGET.result.fields)) {
      out[key] = await innerTextOf(page, sel);
    }
    return out;
  }

  // Cổng BHXH thật: message là 1 chuỗi gộp -> parse theo nhãn.
  if (TARGET.result.parse === 'bhyt') {
    const data = await page.evaluate(
      (sel) => {
        const pick = (s) => {
          for (const el of document.querySelectorAll(s)) {
            const t = (el.innerText || '').trim();
            if (t) return t;
          }
          return '';
        };
        const sections = [];
        document.querySelectorAll(sel.section).forEach((fs) => {
          const lg = fs.querySelector('legend');
          const title = lg ? lg.innerText.trim() : '';
          const clone = fs.cloneNode(true);
          const l2 = clone.querySelector('legend');
          if (l2) l2.remove();
          const text = (clone.innerText || '').replace(/\s+/g, ' ').trim();
          sections.push({ title, text });
        });
        return { message: pick(sel.message), sections };
      },
      { message: TARGET.result.message, section: TARGET.result.section }
    );

    const message = data.message || (data.sections.find((s) => s.text)?.text ?? '');
    const parsed = parseBhyt(message);
    // Khối phụ có nội dung (vd "Quyền lợi" khi thẻ còn hạn)
    const extra = data.sections.filter(
      (s) => s.text && s.title && s.title.toLowerCase() !== 'thông báo'
    );
    return { ...parsed, extra, raw: message };
  }

  // Fallback: raw text + html.
  const container = TARGET.result.container || TARGET.result.ready;
  return {
    raw: await innerTextOf(page, container),
    html: await innerHTMLOf(page, container)
  };
}

// Nhãn xuất hiện trong chuỗi kết quả của cổng, theo thứ tự.
const BHYT_LABELS = ['Mã thẻ', 'Họ tên', 'Ngày sinh', 'Giới tính', 'ĐC', 'Nơi KCBBĐ', 'Hạn thẻ'];
const BHYT_DISPLAY = { 'ĐC': 'Địa chỉ', 'Nơi KCBBĐ': 'Nơi KCB ban đầu' };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Tách chuỗi gộp thành { title (trạng thái), items: [{label,value}] }.
export function parseBhyt(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text) return { title: null, items: [] };

  const alt = BHYT_LABELS.map(escapeRe).join('|');
  const firstIdx = text.search(new RegExp(`(?:${alt})\\s*:`));
  const title = (firstIdx > 0 ? text.slice(0, firstIdx) : text)
    .replace(/[\s,;()]+$/, '')
    .trim();

  const items = [];
  for (const label of BHYT_LABELS) {
    const re = new RegExp(`${escapeRe(label)}\\s*:\\s*([\\s\\S]*?)\\s*(?=(?:${alt})\\s*:|$)`);
    const m = text.match(re);
    if (!m) continue;
    const value = m[1]
      .trim()
      .replace(/^[\s,;()]+/, '')
      .replace(/[\s,;()!]+$/, '')
      .trim();
    if (value) items.push({ label: BHYT_DISPLAY[label] || label, value });
  }
  return { title, items };
}

async function innerTextOf(page, sel) {
  try {
    const t = await page.locator(sel).first().innerText({ timeout: 1000 });
    return t.trim();
  } catch {
    return null;
  }
}

async function innerHTMLOf(page, sel) {
  try {
    return await page.locator(sel).first().innerHTML({ timeout: 1000 });
  } catch {
    return null;
  }
}
