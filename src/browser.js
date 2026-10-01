// Manages one browser session and streams CDP ScreenCast frames into the UI.
//
// Persistent profile keeps cookies across runs; the optional proxy is for
// network setups such as corporate proxies.

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
const BROWSER_NO_SANDBOX = process.env.BROWSER_NO_SANDBOX === 'true';

let context = null;
let page = null;
let cdp = null;
let screencast = null;

async function ensureContext() {
  if (context) return context;
  const appView = BROWSER_VIEW === 'app';
  const executablePath = CHROME_EXECUTABLE_PATH || (appView ? findHeadlessBrowser() : findSystemBrowser());
  const headless = appView;
  const args = [
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    `--lang=${LOCALE}`
  ];
  if (BROWSER_NO_SANDBOX) args.unshift('--no-sandbox');
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
    `[browser] BROWSER_VIEW=${BROWSER_VIEW} headless=${headless} noSandbox=${BROWSER_NO_SANDBOX} proxy=${redactProxyForLog(PROXY_SERVER)} locale=${LOCALE} tz=${TIMEZONE} executable=${executablePath || 'playwright-default'}`
  );
  return context;
}

function findHeadlessBrowser() {
  return findSystemBrowser() || findPlaywrightHeadlessShell();
}

const LINUX_BROWSER_PATHS = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/microsoft-edge',
  '/opt/microsoft/msedge/msedge',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

// Relative paths (inside each chromium_headless_shell-<rev> folder) per platform.
// Older Linux builds shipped the shell as chrome-linux/headless_shell.
const HEADLESS_SHELL_PATHS = {
  win32: [['chrome-headless-shell-win64', 'chrome-headless-shell.exe']],
  linux: [
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ['chrome-linux', 'headless_shell']
  ]
};

function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function systemBrowserCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const apps = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe']
    ];
    return apps.flatMap((app) => roots.map((root) => path.win32.join(root, ...app)));
  }
  if (platform === 'linux') return [...LINUX_BROWSER_PATHS];
  return [];
}

export function playwrightCacheDir({ platform = process.platform, env = process.env } = {}) {
  const p = pathFor(platform);
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    return env.PLAYWRIGHT_BROWSERS_PATH;
  }
  if (platform === 'win32') return env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'ms-playwright') : '';
  if (platform === 'linux') {
    const cacheHome = env.XDG_CACHE_HOME || (env.HOME ? p.join(env.HOME, '.cache') : '');
    return cacheHome ? p.join(cacheHome, 'ms-playwright') : '';
  }
  return '';
}

export function findPlaywrightHeadlessShell({
  platform = process.platform,
  env = process.env,
  fsImpl = fs
} = {}) {
  const root = playwrightCacheDir({ platform, env });
  const relativePaths = HEADLESS_SHELL_PATHS[platform];
  if (!root || !relativePaths) return '';
  const p = pathFor(platform);
  try {
    return fsImpl
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium_headless_shell-'))
      .map((entry) => {
        const version = Number(entry.name.replace('chromium_headless_shell-', '')) || 0;
        const base = p.join(root, entry.name);
        const executable = relativePaths
          .map((parts) => p.join(base, ...parts))
          .find((candidate) => fsImpl.existsSync(candidate));
        return { version, executable, complete: p.join(base, 'INSTALLATION_COMPLETE') };
      })
      .filter((candidate) => candidate.executable && fsImpl.existsSync(candidate.complete))
      .sort((a, b) => b.version - a.version)[0]?.executable || '';
  } catch {
    return '';
  }
}

// Snap Chromium (and Ubuntu's /usr/bin/chromium-browser shim that execs it) is
// confined and often cannot use a profile outside $HOME, so skip it and let
// Playwright's bundled Chromium take over.
const MAX_LAUNCHER_SCRIPT_BYTES = 64 * 1024;

export function isSnapLauncher(candidate, fsImpl = fs) {
  try {
    if (fsImpl.realpathSync(candidate).startsWith('/snap/')) return true;
    if (fsImpl.statSync(candidate).size > MAX_LAUNCHER_SCRIPT_BYTES) return false;
    return fsImpl.readFileSync(candidate, 'utf8').includes('/snap/');
  } catch {
    return false;
  }
}

export function findSystemBrowser({ platform = process.platform, env = process.env, fsImpl = fs } = {}) {
  return systemBrowserCandidates({ platform, env }).find(
    (candidate) => fsImpl.existsSync(candidate) && !(platform === 'linux' && isSnapLauncher(candidate, fsImpl))
  ) || '';
}

export function redactProxyForLog(proxyServer) {
  if (!proxyServer) return 'none';
  try {
    const url = new URL(proxyServer);
    const credentials = url.username || url.password ? '***:***@' : '';
    return `${url.protocol}//${credentials}${url.host}`;
  } catch {
    return '[configured]';
  }
}

export function createScreencastStream(
  cdpSession,
  { emitFrame, viewport = VIEWPORT, quality = 90 } = {}
) {
  if (!cdpSession || typeof cdpSession.send !== 'function') {
    throw new TypeError('cdpSession.send must be a function');
  }
  if (typeof cdpSession.on !== 'function' || typeof cdpSession.off !== 'function') {
    throw new TypeError('cdpSession.on and cdpSession.off must be functions');
  }
  if (typeof emitFrame !== 'function') {
    throw new TypeError('emitFrame must be a function');
  }

  let listener = null;
  let startPromise = null;
  let active = false;
  let started = false;

  async function sendAck(sessionId) {
    try {
      await cdpSession.send('Page.screencastFrameAck', { sessionId });
    } catch {
      // The page may close between receiving a frame and acknowledging it.
    }
  }

  async function handleFrame({ data, sessionId } = {}) {
    try {
      if (active && typeof data === 'string') emitFrame(data);
    } catch {
      // A disconnected UI must not break the browser screencast.
    }
    await sendAck(sessionId);
  }

  async function start() {
    if (active) return startPromise;

    active = true;
    listener = (frame) => {
      handleFrame(frame).catch(() => {});
    };
    cdpSession.on('Page.screencastFrame', listener);

    startPromise = (async () => {
      try {
        await cdpSession.send('Page.startScreencast', {
          format: 'jpeg',
          quality,
          maxWidth: viewport.width,
          maxHeight: viewport.height
        });
        started = true;
      } catch (err) {
        active = false;
        const failedListener = listener;
        if (failedListener) cdpSession.off('Page.screencastFrame', failedListener);
        listener = null;
        throw err;
      } finally {
        startPromise = null;
      }
    })();

    return startPromise;
  }

  async function stop() {
    active = false;
    const currentListener = listener;
    listener = null;
    if (currentListener) cdpSession.off('Page.screencastFrame', currentListener);

    if (startPromise) await startPromise.catch(() => {});
    if (!started) return;

    started = false;
    try {
      await cdpSession.send('Page.stopScreencast');
    } catch {
      // The page/session may already be closed.
    }
  }

  return { start, stop };
}

async function startFrameStream() {
  cdp = await context.newCDPSession(page);
  screencast = createScreencastStream(cdp, {
    viewport: VIEWPORT,
    emitFrame: (data) => bus.emit('frame', { data })
  });
  try {
    await screencast.start();
  } catch (err) {
    await screencast.stop().catch(() => {});
    screencast = null;
    try { await cdp.detach(); } catch {}
    cdp = null;
    throw err;
  }
}

async function stopFrameStream() {
  const currentScreencast = screencast;
  screencast = null;
  if (currentScreencast) await currentScreencast.stop().catch(() => {});

  const currentCdp = cdp;
  cdp = null;
  if (currentCdp) {
    try { await currentCdp.detach(); } catch {}
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
const INPUT_KINDS = new Set(['move', 'down', 'up', 'wheel']);
const MAX_WHEEL_DELTA = 5000;

export function isValidInputEvent(evt) {
  if (!evt || typeof evt !== 'object' || evt.type !== 'input' || !INPUT_KINDS.has(evt.kind)) {
    return false;
  }
  if (!Number.isFinite(evt.nx) || evt.nx < 0 || evt.nx > 1) return false;
  if (!Number.isFinite(evt.ny) || evt.ny < 0 || evt.ny > 1) return false;
  if (evt.kind === 'wheel') {
    return Number.isFinite(evt.dx)
      && Number.isFinite(evt.dy)
      && Math.abs(evt.dx) <= MAX_WHEEL_DELTA
      && Math.abs(evt.dy) <= MAX_WHEEL_DELTA;
  }
  return true;
}

export async function dispatchInput(evt) {
  if (!isValidInputEvent(evt) || !cdp) return false;
  const x = Math.round(evt.nx * VIEWPORT.width);
  const y = Math.round(evt.ny * VIEWPORT.height);

  if (evt.kind === 'wheel') {
    await cdp
      .send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: evt.dx, deltaY: evt.dy })
      .catch(() => {});
    return true;
  }

  const typeMap = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' };
  const type = typeMap[evt.kind];
  if (!type) return false;

  const params = { type, x, y };
  if (evt.kind === 'down' || evt.kind === 'up') {
    params.button = 'left';
    params.clickCount = 1;
  }
  await cdp.send('Input.dispatchMouseEvent', params).catch(() => {});
  return true;
}

export async function closeAll() {
  await stopFrameStream();
  try { if (context) await context.close(); } catch {}
  context = page = null;
}
