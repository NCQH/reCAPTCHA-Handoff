const el = (id) => document.getElementById(id);

const msgBox = el('msg');
const startBtn = el('start');
const reloadBtn = el('reload');
const screen = el('screen');
const placeholder = el('placeholder');
const stage = el('stage');
const viewportBox = el('viewport');
const modeTag = el('modeTag');
const connText = el('connText');
const dot = el('dot');

let viewport = { width: 1280, height: 760 };
let focusRect = null;
let ws;

function hasFrame() {
  return screen.src && screen.src.startsWith('data:image/');
}

function showPlaceholder() {
  screen.style.display = 'none';
  placeholder.style.display = '';
  stage.classList.remove('ready');
  viewportBox.style.width = '';
  viewportBox.style.height = '';
  screen.style.width = '';
  screen.style.height = '';
  screen.style.transform = '';
}

function applyView() {
  if (!hasFrame() || !focusRect) {
    showPlaceholder();
    return;
  }

  const x = Math.max(0, focusRect.x);
  const y = Math.max(0, focusRect.y);
  const w = Math.min(viewport.width - x, focusRect.w);
  const h = Math.min(viewport.height - y, focusRect.h);
  const maxW = Math.max(Math.min(window.innerWidth - 32, 560), 1);
  const maxH = Math.max(Math.min(window.innerHeight - 220, 620), 1);
  const zoom = Math.min(maxW / w, maxH / h, 1);
  const outW = Math.round(w * zoom);
  const outH = Math.round(h * zoom);

  stage.classList.add('ready');
  placeholder.style.display = 'none';
  screen.style.display = 'block';
  viewportBox.style.width = `${outW}px`;
  viewportBox.style.height = `${outH}px`;
  screen.style.width = `${viewport.width * zoom}px`;
  screen.style.height = `${viewport.height * zoom}px`;
  screen.style.transform = `translate(${-x * zoom}px, ${-y * zoom}px)`;
}

fetch('/api/config')
  .then((response) => response.json())
  .then((config) => {
    if (modeTag) modeTag.textContent = `${config.mode} - ${config.url}`;
    if (config.viewport) viewport = config.viewport;
  })
  .catch(() => {});

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function connect() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    dot?.classList.add('on');
    if (connText) connText.textContent = 'connected';
    startBtn.disabled = false;
    reloadBtn.disabled = false;
  };

  ws.onclose = () => {
    dot?.classList.remove('on');
    if (connText) connText.textContent = 'reconnecting';
    startBtn.disabled = true;
    reloadBtn.disabled = true;
    setTimeout(connect, 1500);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'frame') {
      screen.src = `data:image/jpeg;base64,${data.data}`;
      applyView();
      return;
    }

    if (data.type === 'focus') {
      focusRect = data.rect;
      applyView();
      return;
    }

    if (data.type === 'state') {
      if (data.message) msgBox.textContent = data.message;
      msgBox.classList.toggle('error', data.state === 'FAILED');
      if (data.state === 'FAILED' || data.state === 'DONE') startBtn.disabled = false;
    }
  };
}

connect();

startBtn.onclick = () => {
  startBtn.disabled = true;
  msgBox.classList.remove('error');
  msgBox.textContent = 'Opening Google reCAPTCHA demo...';
  send({ type: 'start' });
};

reloadBtn.onclick = () => {
  focusRect = null;
  screen.removeAttribute('src');
  showPlaceholder();
  msgBox.classList.remove('error');
  msgBox.textContent = 'Reloading...';
  send({ type: 'cancel', force: true });
  setTimeout(() => send({ type: 'start' }), 250);
};

window.addEventListener('beforeunload', () => {
  send({ type: 'cancel', force: true });
});

function norm(event) {
  const bounds = screen.getBoundingClientRect();
  return {
    nx: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
    ny: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))
  };
}

function blockLiveViewEvent(event) {
  event.preventDefault();
  event.stopPropagation();
}

let lastMove = 0;
screen.addEventListener('mousemove', (event) => {
  const now = performance.now();
  if (now - lastMove < 35) return;
  lastMove = now;
  send({ type: 'input', kind: 'move', ...norm(event) });
});

screen.addEventListener('mousedown', (event) => {
  if (event.button !== 0) {
    blockLiveViewEvent(event);
    return;
  }
  event.preventDefault();
  send({ type: 'input', kind: 'down', ...norm(event) });
});

window.addEventListener('mouseup', (event) => {
  if (screen.style.display !== 'block') return;
  if (event.button !== 0) return;
  send({ type: 'input', kind: 'up', ...norm(event) });
});

screen.addEventListener('contextmenu', blockLiveViewEvent);
screen.addEventListener('auxclick', blockLiveViewEvent);
screen.addEventListener('wheel', blockLiveViewEvent, { passive: false });
