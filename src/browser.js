// Quản lý MỘT session browser + STREAM màn hình lên UI qua CDP screencast (Phương án B).
//
// #3 Làm ấm profile + IP:
//   - launchPersistentContext(PROFILE_DIR): cookie/localStorage + điểm tin cậy reCAPTCHA
//     được GIỮ LẠI trên đĩa qua các lần chạy -> profile "ấm" -> ít bị đố hình dần.
//   - proxy (PROXY_SERVER...): trỏ ra IP sạch/residential để giảm rủi ro bị chặn.
//   - locale/timezone VN + tắt cờ AutomationControlled -> giảm dấu vết tự động hoá.

import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const bus = new EventEmitter(); // 'frame' => { data }, 'focus' broadcast ở orchestrator
export const VIEWPORT = { width: 1280, height: 760 };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// app (mặc định) = headless không cửa sổ | hidden = headful ngoài màn hình | desktop = headful hiện
const BROWSER_VIEW = (process.env.BROWSER_VIEW || 'app').toLowerCase();
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, '..', '.profile');
const PROXY_SERVER = process.env.PROXY_SERVER || ''; // vd: http://ip:port | socks5://ip:port
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';
const LOCALE = process.env.BROWSER_LOCALE || 'vi-VN';
const TIMEZONE = process.env.BROWSER_TZ || 'Asia/Ho_Chi_Minh';
const CHROME_EXECUTABLE_PATH = process.env.CHROME_EXECUTABLE_PATH || findSystemBrowser();

let context = null;
let page = null;
let cdp = null;

async function ensureContext() {
  if (context) return context;
  const headless = BROWSER_VIEW === 'app';
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled'
  ];
  if (!headless) {
    args.push(`--window-size=${VIEWPORT.width},${VIEWPORT.height + 90}`);
    args.push(BROWSER_VIEW === 'hidden' ? '--window-position=-32000,-32000' : '--window-position=0,0');
  }

  const options = {
    headless,
    args,
    viewport: VIEWPORT,
    locale: LOCALE,
    timezoneId: TIMEZONE
  };
  if (CHROME_EXECUTABLE_PATH) {
    options.executablePath = CHROME_EXECUTABLE_PATH;
  }
  if (PROXY_SERVER) {
    options.proxy = { server: PROXY_SERVER };
    if (PROXY_USERNAME) {
      options.proxy.username = PROXY_USERNAME;
      options.proxy.password = PROXY_PASSWORD;
    }
  }

  // Persistent context: profile bền trên đĩa -> "ấm" dần.
  context = await chromium.launchPersistentContext(PROFILE_DIR, options);
  console.log(`[browser] profile bền: ${PROFILE_DIR}`);
  console.log(
    `[browser] BROWSER_VIEW=${BROWSER_VIEW} headless=${headless} proxy=${PROXY_SERVER || 'none'} tz=${TIMEZONE} executable=${CHROME_EXECUTABLE_PATH || 'playwright-default'}`
  );
  return context;
}

function findSystemBrowser() {
  const candidates = [
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

async function startScreencast() {
  cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', async (payload) => {
    bus.emit('frame', { data: payload.data });
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: payload.sessionId });
    } catch {
      /* frame cũ, bỏ qua */
    }
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 90,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1
  });
}

async function stopScreencast() {
  if (cdp) {
    try { await cdp.send('Page.stopScreencast'); } catch {}
    try { await cdp.detach(); } catch {}
    cdp = null;
  }
}

export async function getPage() {
  if (page && !page.isClosed()) return page;
  await ensureContext();
  // Tái dùng page có sẵn của persistent context (tránh mở thừa tab).
  const existing = context.pages().find((p) => !p.isClosed());
  page = existing || (await context.newPage());
  await page.setViewportSize(VIEWPORT).catch(() => {});
  await startScreencast();
  return page;
}

export async function resetPage() {
  // Tạo page mới cho job mới nhưng GIỮ context (giữ profile ấm trong phiên).
  await stopScreencast();
  if (page && !page.isClosed()) {
    await page.close().catch(() => {});
  }
  page = null;
  return getPage();
}

// Thao tác chuột của người (toạ độ chuẩn hoá 0..1) -> dispatch vào browser.
export async function dispatchInput(evt) {
  if (!cdp) return;
  const x = Math.round((evt.nx ?? 0) * VIEWPORT.width);
  const y = Math.round((evt.ny ?? 0) * VIEWPORT.height);

  if (evt.kind === 'wheel') {
    await cdp
      .send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: evt.dx || 0, deltaY: evt.dy || 0 })
      .catch(() => {});
    return;
  }

  const typeMap = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' };
  const type = typeMap[evt.kind];
  if (!type) return;

  const params = { type, x, y };
  if (evt.kind === 'down' || evt.kind === 'up') {
    params.button = 'left';
    params.clickCount = 1;
  }
  await cdp.send('Input.dispatchMouseEvent', params).catch(() => {});
}

// Reset widget reCAPTCHA (dùng khi token hết hạn / bị từ chối) -> người click lại.
export async function resetCaptcha() {
  if (!page || page.isClosed()) return;
  await page
    .evaluate(() => {
      try { if (window.grecaptcha) window.grecaptcha.reset(); } catch {}
      const t = document.querySelector('#tokenRecaptch');
      if (t) t.value = '';
      document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach((el) => (el.value = ''));
    })
    .catch(() => {});
}

export async function closeAll() {
  await stopScreencast();
  try { if (context) await context.close(); } catch {}
  context = page = null;
}
