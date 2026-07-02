// Orchestrator: phục vụ Operator UI + WebSocket, chạy demo site nội bộ,
// và điều phối job qua state machine. MVP xử lý 1 job tại một thời điểm.

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTS, TARGET } from './config.js';
import { waitForCaptchaFocus, createCaptchaFocusTracker } from './captcha-handoff.js';
import { runJob } from './job.js';
import { startDemoSite } from '../demo-site/server.js';
import { closeAll, bus, dispatchInput, getPage, VIEWPORT } from './browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Demo site (giả lập cổng BHXH) chạy nội bộ ---
startDemoSite(PORTS.demo);

// --- Operator UI + WebSocket ---
const app = express();
// no-store: tránh trình duyệt cache app.js/index.html cũ khi ta cập nhật UI
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
  })
);

// Cho UI biết mode + kích thước viewport (để map/crop live-view)
app.get('/api/config', (_req, res) => {
  res.json({ mode: TARGET.mode, viewport: VIEWPORT });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let busy = false;
let activeJob = null;
const captchaFocus = createCaptchaFocusTracker({
  target: TARGET,
  emitFocus: (rect) => bus.emit('focus', rect)
});

async function abortActiveJob(owner, reason = 'CANCELLED', force = false) {
  if (!activeJob || (!force && activeJob.ws !== owner)) return;
  activeJob.controller.abort(reason);
  activeJob = null;
  busy = false;
  captchaFocus.stop();
  await closeAll().catch(() => {});
}

async function startPreview() {
  if (busy) return;
  captchaFocus.stop();
  const page = await getPage();
  await page.goto(TARGET.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  captchaFocus.start(page);
  await waitForCaptchaFocus(page, { target: TARGET, onFocus: (rect) => bus.emit('focus', rect) });
}

wss.on('connection', (ws) => {
  const emit = (state, extra = {}) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'state', state, ...extra }));
    }
  };

  ws.send(JSON.stringify({ type: 'hello', message: 'Kết nối orchestrator OK.' }));
  startPreview().catch(() => {});

  // Đẩy frame + vùng crop tới MỌI client (broadcast) để tab nào cũng đồng bộ.
  const onFrame = (f) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'frame', data: f.data }));
  };
  const onFocus = (rect) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'focus', rect }));
  };
  bus.on('frame', onFrame);
  bus.on('focus', onFocus);
  ws.on('close', () => {
    bus.off('frame', onFrame);
    bus.off('focus', onFocus);
    abortActiveJob(ws, 'CLIENT_DISCONNECTED').catch(() => {});
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Thao tác chuột của người trong panel live-view -> dispatch vào browser.
    if (msg.type === 'input') {
      dispatchInput(msg).catch(() => {});
      return;
    }

    if (msg.type === 'cancel') {
      await abortActiveJob(ws, 'CLIENT_CANCELLED', Boolean(msg.force));
      return;
    }

    if (msg.type === 'submit') {
      if (busy && activeJob) {
        await abortActiveJob(activeJob.ws, 'REPLACED_BY_NEW_JOB', true);
      }
      if (busy) {
        emit('FAILED', { message: 'Đang bận xử lý một job khác (MVP chỉ 1 session).' });
        return;
      }
      busy = true;
      const controller = new AbortController();
      activeJob = { ws, controller };
      try {
        await runJob(
          {
            maso: msg.maso,
            hoten: msg.hoten,
            ngaysinh: msg.ngaysinh
          },
          emit,
          (rect) => bus.emit('focus', rect), // broadcast crop tới mọi client
          { signal: controller.signal, onPage: captchaFocus.start }
        );
      } catch (err) {
        // Không để bất kỳ lỗi nào làm sập server
        emit('FAILED', { message: `Lỗi không mong đợi: ${err.message}` });
      } finally {
        if (activeJob?.controller === controller) activeJob = null;
        busy = false;
        captchaFocus.stop();
      }
    }
  });
});

server.listen(PORTS.operator, () => {
  console.log(`[orchestrator] TARGET_MODE=${TARGET.mode} -> ${TARGET.url}`);
  console.log(`[orchestrator] Operator UI: http://localhost:${PORTS.operator}`);
  console.log(`[orchestrator] Demo site (nội bộ): http://localhost:${PORTS.demo}`);
  console.log('[orchestrator] Browser hiển thị trong app (BROWSER_VIEW=app => headless, không cửa sổ).');
});

// Dọn dẹp khi tắt
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n[orchestrator] ${sig} — đang đóng browser…`);
    captchaFocus.stop();
    await closeAll();
    process.exit(0);
  });
}
