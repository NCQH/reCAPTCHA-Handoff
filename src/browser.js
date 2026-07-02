// Manages one browser session and streams page screenshots into the UI.
//
// Persistent profile and optional proxy settings keep the browser closer to a
// real browsing session across runs.

import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const bus = new EventEmitter(); // 'frame' => { data }, 'focus' is broadcast by orchestrator
export const VIEWPORT = { width: 1280, height: 760 };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// app = headless streamed UI | hidden = off-screen headful | desktop = visible headful
const BROWSER_VIEW = (process.env.BROWSER_VIEW || 'app').toLowerCase();
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, '..', '.profile');
const PROXY_SERVER = process.env.PROXY_SERVER || ''; // e.g. http://ip:port | socks5://ip:port
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';
const LOCALE = process.env.BROWSER_LOCALE || 'en-US';
const TIMEZONE = process.env.BROWSER_TZ || 'Asia/Ho_Chi_Minh';
const CHROME_EXECUTABLE_PATH = process.env.CHROME_EXECUTABLE_PATH || '';

let context = null;
let page = null;
let cdp = null;
let frameTimer = null;
let frameBusy = false;

async function ensureContext() {
  if (context) return context;
  const appView = BROWSER_VIEW === 'app';
  const executablePath = CHROME_EXECUTABLE_PATH || (appView ? findHeadlessBrowser() : findSystemBrowser());
  const headless = appView;
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    `--lang=${LOCALE}`
  ];
  if (appView) {
    args.push(`--window-size=${VIEWPORT.width},${VIEWPORT.height + 90}`);
  } else if (!headless) {
    args.push(`--window-size=${VIEWPORT.width},${VIEWPORT.height + 90}`);
    args.push(BROWSER_VIEW === 'hidden' ? '--window-position=-32000,-32000' : '--window-position=0,0');
  }

  const options = {
    headless,
    args,
    viewport: VIEWPORT,
    locale: LOCALE,
    extraHTTPHeaders: { 'Accept-Language': `${LOCALE},en;q=0.9` },
    timezoneId: TIMEZONE
  };
  if (executablePath) {
    options.executablePath = executablePath;
  }
  if (PROXY_SERVER) {
    options.proxy = { server: PROXY_SERVER };
    if (PROXY_USERNAME) {
      options.proxy.username = PROXY_USERNAME;
      options.proxy.password = PROXY_PASSWORD;
    }
  }

  // Persistent context keeps cookies and local storage across runs.
  context = await chromium.launchPersistentContext(PROFILE_DIR, options);
  console.log(`[browser] persistent profile: ${PROFILE_DIR}`);
  console.log(
    `[browser] BROWSER_VIEW=${BROWSER_VIEW} headless=${headless} proxy=${PROXY_SERVER || 'none'} locale=${LOCALE} tz=${TIMEZONE} executable=${executablePath || 'playwright-default'}`
  );
  return context;
}

function findHeadlessBrowser() {
  return findSystemBrowser() || findPlaywrightHeadlessShell();
}

function findPlaywrightHeadlessShell() {
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium_headless_shell-'))
      .map((entry) => {
        const version = Number(entry.name.replace('chromium_headless_shell-', '')) || 0;
        const base = path.join(root, entry.name);
        return {
          version,
          executable: path.join(base, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
          complete: path.join(base, 'INSTALLATION_COMPLETE')
        };
      })
      .filter((candidate) => fs.existsSync(candidate.executable) && fs.existsSync(candidate.complete))
      .sort((a, b) => b.version - a.version)[0]?.executable || '';
  } catch {
    return '';
  }
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

async function startFrameStream() {
  cdp = await context.newCDPSession(page);
  await captureFrame();
  frameTimer = setInterval(() => {
    captureFrame().catch(() => {});
  }, 250);
}

async function stopFrameStream() {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
  if (cdp) {
    try { await cdp.detach(); } catch {}
    cdp = null;
  }
  frameBusy = false;
}

async function captureFrame() {
  if (frameBusy || !page || page.isClosed()) return;
  frameBusy = true;
  try {
    const frame = await page.screenshot({
      type: 'jpeg',
      quality: 90,
      fullPage: false,
      animations: 'allow'
    });
    bus.emit('frame', { data: frame.toString('base64') });
  } finally {
    frameBusy = false;
  }
}

export async function getPage() {
  if (page && !page.isClosed()) return page;
  await ensureContext();
  // Reuse an existing persistent-context page when possible.
  const existing = context.pages().find((p) => !p.isClosed());
  page = existing || (await context.newPage());
  await page.setViewportSize(VIEWPORT).catch(() => {});
  await startFrameStream();
  return page;
}

export async function resetPage() {
  // Create a fresh page for the next job while keeping the persistent context.
  await stopFrameStream();
  if (page && !page.isClosed()) {
    await page.close().catch(() => {});
  }
  page = null;
  return getPage();
}

// Human mouse events use normalized 0..1 coordinates and are dispatched into the browser.
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

export async function closeAll() {
  await stopFrameStream();
  try { if (context) await context.close(); } catch {}
  context = page = null;
}
