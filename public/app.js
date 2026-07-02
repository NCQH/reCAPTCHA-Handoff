// Operator UI: 1 giao diện duy nhất.
//  - Nhận frame screencast -> vẽ vào <img> (live-view).
//  - Gửi thao tác chuột (toạ độ chuẩn hoá 0..1) về server -> CDP dispatch vào browser.
//  - Người click reCAPTCHA NGAY trong panel này (không đụng cửa sổ desktop).

const el = (id) => document.getElementById(id);
const msgBox = el('msg');
const resultBox = el('result');
const goBtn = el('go');
const screen = el('screen');
const ph = el('ph');
const stage = document.querySelector('.stage');
const vp = el('vp');
const captchaBox = el('captchaBox');
const resetBtn = el('resetForm');
const modeTag = el('modeTag');
const dot = el('dot');
const connText = el('connText');

// --- Crop live-view về đúng vùng captcha ---
let viewport = { width: 1280, height: 760 };
let focusRect = null;      // rect viewport CSS px, hoặc null = toàn màn hình
let focusEnabled = true;   // người dùng có thể tắt để xem toàn màn hình
let currentState = '';

function hasFrame() {
  return screen.src && screen.src.startsWith('data:image/');
}

function shouldShowLive() {
  return hasFrame() && Boolean(focusRect);
}

function showLiveFrame() {
  captchaBox.classList.add('has-frame');
  screen.style.display = 'block';
  ph.style.display = 'none';
}

function hideLiveFrame() {
  captchaBox.classList.remove('has-frame');
  screen.style.display = 'none';
  ph.style.display = '';
  captchaBox.style.width = '';
  captchaBox.style.height = '';
  stage.style.width = '';
  stage.style.height = '';
  stage.classList.remove('focus');
  vp.style.width = '';
  vp.style.height = '';
  screen.style.objectFit = '';
  screen.style.transform = '';
}

function applyView() {
  if (!hasFrame()) {
    hideLiveFrame();
    return;
  }

  if (!focusRect) return;

  const pad = 0;
  const x = Math.max(0, focusRect.x - pad);
  const y = Math.max(0, focusRect.y - pad);
  const w = Math.min(viewport.width - x, focusRect.w + pad * 2);
  const h = Math.min(viewport.height - y, focusRect.h + pad * 2);
  const maxW = Math.max(Math.min(window.innerWidth - 32, 520), 1);
  const maxH = Math.max(Math.min(window.innerHeight - 180, 620), 1);
  const zoom = Math.min(maxW / w, maxH / h, 1);
  const outW = Math.round(w * zoom);
  const outH = Math.round(h * zoom);
  captchaBox.style.width = `${outW}px`;
  captchaBox.style.height = `${outH}px`;
  stage.style.width = '100%';
  stage.style.height = '100%';
  stage.classList.add('focus');
  vp.style.width = outW + 'px';
  vp.style.height = outH + 'px';
  screen.style.maxWidth = screen.style.maxHeight = 'none';
  screen.style.width = viewport.width * zoom + 'px';
  screen.style.height = viewport.height * zoom + 'px';
  screen.style.objectFit = '';
  screen.style.transform = `translate(${-x * zoom}px, ${-y * zoom}px)`;
}

el('toggleView').onclick = () => {
  focusEnabled = !focusEnabled;
  focusEnabled = true;
  el('toggleView').textContent = 'Captcha';
  applyView();
};

// Hiển thị kết quả dạng list (nếu có items) hoặc JSON (fallback).
function renderResult(result) {
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  if (Array.isArray(result.items) && result.items.length) {
    let html = '';
    if (result.title) html += `<div class="rtitle">${esc(result.title)}</div>`;
    html += '<ul class="rlist">';
    for (const it of result.items) html += `<li><span class="rk">${esc(it.label)}:</span> ${esc(it.value)}</li>`;
    html += '</ul>';
    if (Array.isArray(result.extra)) {
      for (const s of result.extra) {
        if (s.text) html += `<div class="rsec"><b>${esc(s.title)}:</b> ${esc(s.text)}</div>`;
      }
    }
    resultBox.innerHTML = html;
  } else {
    resultBox.textContent = JSON.stringify(result, null, 2);
  }
}

fetch('/api/config').then((r) => r.json())
  .then((cfg) => {
    if (modeTag) modeTag.textContent = `MVP · live-view · ${cfg.mode}`;
    if (cfg.viewport) viewport = cfg.viewport;
  })
  .catch(() => {});

// --- WebSocket ---
let ws;
function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => {
    dot?.classList.add('on');
    if (connText) connText.textContent = 'đã kết nối';
    goBtn.disabled = false;
  };
  ws.onclose = () => {
    dot?.classList.remove('on');
    if (connText) connText.textContent = 'mất kết nối — thử lại…';
    goBtn.disabled = true;
    setTimeout(connect, 1500);
  };

  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);

    if (data.type === 'frame') {
      screen.src = 'data:image/jpeg;base64,' + data.data;
      if (shouldShowLive()) {
        showLiveFrame();
        applyView();
      }
      return;
    }

    if (data.type === 'focus') {
      focusRect = data.rect;
      if (shouldShowLive()) {
        showLiveFrame();
        applyView();
      } else {
        hideLiveFrame();
        applyView();
      }
      return;
    }

    if (data.type === 'state') {
      currentState = data.state;
      if (shouldShowLive()) {
        showLiveFrame();
        applyView();
      } else {
        hideLiveFrame();
      }
      if (data.message) msgBox.textContent = data.message;
      msgBox.style.color = data.state === 'FAILED' ? '#b00000' : '';
      if (data.state === 'DONE' && data.result) {
        resultBox.style.display = 'block';
        renderResult(data.result);
      }
      if (data.state === 'FAILED' || data.state === 'DONE') goBtn.disabled = false;
    }
  };
}
connect();

goBtn.onclick = () => {
  resultBox.style.display = 'none';
  resultBox.textContent = '';
  goBtn.disabled = true;
  msgBox.style.color = '';
  currentState = 'FILLING';
  if (hasFrame()) applyView();
  send({ type: 'submit', maso: el('maso').value, hoten: el('hoten').value, ngaysinh: el('ngaysinh').value });
};

resetBtn.onclick = () => {
  el('maso').value = '';
  el('hoten').value = '';
  el('ngaysinh').value = '';
  resultBox.style.display = 'none';
  resultBox.textContent = '';
  msgBox.style.color = '';
  msgBox.textContent = 'Nhập dữ liệu rồi bấm "Tra cứu".';
  currentState = '';
  focusRect = null;
  hideLiveFrame();
  send({ type: 'cancel' });
};

window.addEventListener('beforeunload', () => {
  send({ type: 'cancel' });
});

// --- Chuyển thao tác chuột của người về browser ---
function norm(e) {
  const r = screen.getBoundingClientRect();
  return {
    nx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    ny: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
  };
}

function blockLiveViewEvent(e) {
  e.preventDefault();
  e.stopPropagation();
}

let lastMove = 0;
screen.addEventListener('mousemove', (e) => {
  const now = performance.now();
  if (now - lastMove < 35) return; // throttle ~28fps
  lastMove = now;
  send({ type: 'input', kind: 'move', ...norm(e) });
});
screen.addEventListener('mousedown', (e) => {
  if (e.button !== 0) {
    blockLiveViewEvent(e);
    return;
  }
  e.preventDefault();
  send({ type: 'input', kind: 'down', ...norm(e) });
});
screen.addEventListener('contextmenu', blockLiveViewEvent);
screen.addEventListener('auxclick', blockLiveViewEvent);
// mouseup bắt trên window để không lỡ khi thả chuột ngoài ảnh
window.addEventListener('mouseup', (e) => {
  if (screen.style.display !== 'block') return;
  if (e.button !== 0) {
    if (e.target === screen) blockLiveViewEvent(e);
    return;
  }
  send({ type: 'input', kind: 'up', ...norm(e) });
});
screen.addEventListener('wheel', (e) => {
  blockLiveViewEvent(e);
}, { passive: false });
