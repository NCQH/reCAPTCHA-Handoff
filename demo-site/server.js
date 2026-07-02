import express from 'express';

let server = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

export function startDemoSite(port = 8080) {
  if (server) return server;

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Demo tra cứu BHYT</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f1f5f9; color: #0f172a; }
    main { width: 520px; max-width: calc(100vw - 32px); margin: 42px auto; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 24px; }
    h1 { font-size: 20px; margin: 0 0 18px; }
    label { display: block; margin: 12px 0 5px; font-size: 13px; font-weight: 700; color: #475569; }
    input { width: 100%; padding: 10px 11px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 15px; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 18px; border: 0; border-radius: 6px; background: #0f766e; color: #fff; font-weight: 700; cursor: pointer; }
    iframe { display: block; width: 304px; height: 78px; border: 0; margin-top: 16px; }
    #messeger { margin-top: 12px; color: #b91c1c; font-size: 13px; min-height: 18px; }
  </style>
</head>
<body>
  <main>
    <h1>Demo cổng tra cứu BHYT</h1>
    <form method="post" action="/result" id="frmTraCuu">
      <label for="maso">Mã số BHXH / thẻ BHYT</label>
      <input id="maso" name="maso" autocomplete="off" />
      <label for="hoten">Họ và tên</label>
      <input id="hoten" name="hoten" autocomplete="off" />
      <label for="ngaysinh">Ngày/năm sinh</label>
      <input id="ngaysinh" name="ngaysinh" autocomplete="off" />
      <textarea name="g-recaptcha-response" hidden></textarea>
      <iframe title="Demo reCAPTCHA" src="/recaptcha/api2/anchor"></iframe>
      <div id="messeger"></div>
      <button id="btnTraCuu" type="submit">Tra cứu</button>
    </form>
  </main>
  <script>
    const form = document.getElementById('frmTraCuu');
    const token = document.querySelector('textarea[name="g-recaptcha-response"]');
    const message = document.getElementById('messeger');
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'demo-recaptcha-token') {
        token.value = event.data.token;
        message.textContent = '';
      }
    });
    form.addEventListener('submit', (event) => {
      if (!token.value) {
        event.preventDefault();
        message.textContent = 'Vui lòng xác thực reCAPTCHA demo.';
      }
    });
  </script>
</body>
</html>`);
  });

  app.get('/recaptcha/api2/anchor', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #fff; }
    button { width: 304px; height: 78px; display: flex; align-items: center; gap: 14px; border: 1px solid #dadce0; background: #f9f9f9; cursor: pointer; padding: 13px; font-size: 15px; color: #111827; }
    .box { width: 28px; height: 28px; border: 2px solid #6b7280; background: #fff; display: grid; place-items: center; font-size: 22px; color: #15803d; line-height: 1; }
    .checked .box { border-color: #15803d; }
    .brand { margin-left: auto; font-size: 10px; color: #6b7280; text-align: center; }
  </style>
</head>
<body>
  <button id="captcha" type="button" aria-label="I'm not a robot">
    <span class="box" id="box"></span>
    <span>I'm not a robot</span>
    <span class="brand">demo<br>reCAPTCHA</span>
  </button>
  <script>
    document.getElementById('captcha').addEventListener('click', () => {
      document.getElementById('captcha').classList.add('checked');
      document.getElementById('box').textContent = '✓';
      parent.postMessage({ type: 'demo-recaptcha-token', token: 'demo-token-' + Date.now() }, '*');
    });
  </script>
</body>
</html>`);
  });

  app.post('/result', (req, res) => {
    const hoten = escapeHtml(req.body.hoten || 'Người dùng demo');
    const maso = escapeHtml(req.body.maso || '0000000000');
    const ngaysinh = escapeHtml(req.body.ngaysinh || '1990');
    res.type('html').send(`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kết quả demo BHYT</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f1f5f9; color: #0f172a; }
    main { width: 620px; max-width: calc(100vw - 32px); margin: 42px auto; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 24px; }
    h1 { font-size: 20px; margin: 0 0 18px; }
    dl { display: grid; grid-template-columns: 150px 1fr; gap: 10px 16px; margin: 0; }
    dt { color: #475569; font-weight: 700; }
    dd { margin: 0; }
  </style>
</head>
<body>
  <main id="ket-qua">
    <h1>Kết quả tra cứu demo</h1>
    <dl>
      <dt>Mã thẻ</dt><dd>${maso}</dd>
      <dt>Họ tên</dt><dd id="kq-hoten">${hoten}</dd>
      <dt>Ngày sinh</dt><dd>${ngaysinh}</dd>
      <dt>Thời hạn thẻ</dt><dd id="kq-thoihan">01/01/2026 - 31/12/2026</dd>
      <dt>Nơi KCB ban đầu</dt><dd id="kq-noikcb">Bệnh viện Demo</dd>
      <dt>Trạng thái</dt><dd id="kq-trangthai">Thẻ còn giá trị sử dụng</dd>
    </dl>
  </main>
</body>
</html>`);
  });

  server = app.listen(port, () => {
    console.log(`[demo-site] http://localhost:${port}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  startDemoSite(Number(process.env.PORT || 8080));
}
