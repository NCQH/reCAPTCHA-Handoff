import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTS, STATES, TARGET } from './config.js';
import { createCaptchaFocusTracker } from './captcha-handoff.js';
import { runJob } from './job.js';
import {
  bus,
  closeAll,
  dispatchInput,
  isValidInputEvent,
  VIEWPORT
} from './browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
  })
);

app.get('/api/config', (_req, res) => {
  res.json({ mode: TARGET.mode, url: TARGET.url, viewport: VIEWPORT });
});

const MAX_WS_PAYLOAD = 16 * 1024;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const WS_OPEN = 1;
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORTS.operator}`,
  `http://127.0.0.1:${PORTS.operator}`,
  `http://[::1]:${PORTS.operator}`
]);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  const validPath = request.url === '/';
  const validOrigin = !origin || ALLOWED_ORIGINS.has(origin);
  if (!validPath || !validOrigin) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

let sessionSequence = 0;
let activeSession = null;
let trackedPage = null;
let transition = Promise.resolve();
let cleanupBarrier = Promise.resolve();
const captchaFocus = createCaptchaFocusTracker({
  target: TARGET,
  emitFocus: (rect) => bus.emit('focus', rect)
});

function sendJson(ws, payload, { dropIfBuffered = false } = {}) {
  if (!ws || ws.readyState !== WS_OPEN) return false;
  if (dropIfBuffered && ws.bufferedAmount > MAX_BUFFERED_BYTES) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function emitState(ws, state, extra = {}) {
  return sendJson(ws, { type: 'state', state, ...extra });
}

function enqueueTransition(operation) {
  const next = transition.then(operation, operation);
  transition = next.catch((err) => {
    console.error(`[orchestrator] transition failed: ${err?.message || err}`);
  });
  return next;
}

async function cleanupSession(session) {
  if (session.cleanupPromise) return session.cleanupPromise;

  session.cleanupPromise = (async () => {
    if (activeSession === session) {
      trackedPage = null;
      captchaFocus.stop();
    }
    await closeAll().catch(() => {});
    if (activeSession === session) activeSession = null;
  })();
  cleanupBarrier = session.cleanupPromise;

  return session.cleanupPromise;
}

async function runSession(session) {
  try {
    await runJob(
      session.emit,
      (rect) => bus.emit('focus', rect),
      {
        signal: session.controller.signal,
        onPage: (page) => {
          if (activeSession !== session) return;
          session.page = page;
          trackedPage = page;
          captchaFocus.start(page).catch(() => {});
        }
      }
    );
  } catch (err) {
    session.emit(STATES.FAILED, { message: `Unexpected error: ${err?.message || err}` });
  } finally {
    await cleanupSession(session);
  }
}

async function startSession(ws) {
  await cleanupBarrier;
  if (activeSession) {
    emitState(ws, STATES.FAILED, { message: 'Another captcha session is already running.' });
    return;
  }

  const session = {
    id: ++sessionSequence,
    ws,
    controller: new AbortController(),
    page: null,
    emit: (state, extra = {}) => emitState(ws, state, extra),
    cleanupPromise: null,
    runPromise: null
  };
  activeSession = session;
  session.runPromise = runSession(session);
}

async function cancelSession(ws, reason = 'CANCELLED') {
  const session = activeSession;
  if (!session) {
    emitState(ws, STATES.CANCELLED, { message: 'No active captcha session.' });
    return;
  }
  if (session.ws !== ws) {
    emitState(ws, STATES.FAILED, { message: 'Only the active session owner can cancel it.' });
    return;
  }

  session.controller.abort(reason);
  await cleanupSession(session);
  await session.runPromise?.catch(() => {});
  emitState(ws, STATES.CANCELLED, { message: 'Captcha session cancelled.' });
}

bus.on('frame', () => {
  const page = trackedPage;
  if (page) captchaFocus.publish(page).catch(() => {});
});

wss.on('connection', (ws) => {
  const emit = (state, extra = {}) => {
    emitState(ws, state, extra);
  };

  sendJson(ws, { type: 'hello', message: 'Connected.' });
  ws.on('error', (err) => {
    console.warn(`[orchestrator] WebSocket error: ${err?.message || err}`);
  });

  const onFrame = (frame) => {
    if (activeSession?.ws === ws) {
      sendJson(ws, { type: 'frame', data: frame.data }, { dropIfBuffered: true });
    }
  };
  const onFocus = (rect) => {
    if (activeSession?.ws === ws) sendJson(ws, { type: 'focus', rect });
  };
  bus.on('frame', onFrame);
  bus.on('focus', onFocus);
  ws.on('close', () => {
    bus.off('frame', onFrame);
    bus.off('focus', onFocus);
    enqueueTransition(() => cancelSession(ws, 'CLIENT_DISCONNECTED')).catch(() => {});
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      emit(STATES.FAILED, { message: 'Invalid WebSocket message.' });
      return;
    }

    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
      emit(STATES.FAILED, { message: 'Invalid WebSocket message.' });
      return;
    }

    if (msg.type === 'input') {
      if (activeSession?.ws !== ws || !isValidInputEvent(msg)) return;
      dispatchInput(msg).catch(() => {});
      return;
    }

    if (msg.type === 'cancel') {
      enqueueTransition(() => cancelSession(ws, 'CLIENT_CANCELLED')).catch((err) => {
        emit(STATES.FAILED, { message: `Cancel failed: ${err?.message || err}` });
      });
      return;
    }

    if (msg.type === 'start') {
      enqueueTransition(() => startSession(ws)).catch((err) => {
        emit(STATES.FAILED, { message: `Start failed: ${err?.message || err}` });
      });
      return;
    }

    emit(STATES.FAILED, { message: 'Unknown WebSocket message type.' });
  });
});

server.listen(PORTS.operator, '127.0.0.1', () => {
  console.log(`[orchestrator] target=${TARGET.mode} -> ${TARGET.url}`);
  console.log(`[orchestrator] Operator UI: http://localhost:${PORTS.operator}`);
  console.log('[orchestrator] Browser is streamed into the app.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n[orchestrator] ${sig} - closing browser...`);
    activeSession?.controller.abort(sig);
    activeSession = null;
    trackedPage = null;
    captchaFocus.stop();
    await closeAll();
    process.exit(0);
  });
}
