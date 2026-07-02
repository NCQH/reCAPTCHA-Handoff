// Cấu hình tập trung. Có 2 target: `demo` (site giả lập nội bộ) và `real` (cổng BHXH thật).
// Chọn bằng biến môi trường TARGET_MODE = demo | real  (mặc định: real).
//
// Khác biệt cốt lõi giữa 2 target:
//   - demo: submit ĐIỀU HƯỚNG sang trang kết quả, kết quả có selector cố định.
//   - real: submit chạy AJAX ($.post), KHÔNG điều hướng; kết quả được inject vào #tcContainer,
//           lỗi/validation đổ vào #messeger; token captcha ghi vào hidden #tokenRecaptch.

export const PORTS = {
  operator: 3000, // Operator UI + WebSocket
  demo: 8080      // site demo giả lập cổng BHXH (nội bộ)
};

// ---- TARGET: SITE DEMO (tự host, an toàn, không đụng PII/ToS) ----
const DEMO_TARGET = {
  mode: 'demo',
  url: `http://localhost:${PORTS.demo}/`,
  fields: {
    maso: '#maso',
    hoten: '#hoten',
    ngaysinh: '#ngaysinh'
  },
  submit: '#btnTraCuu',
  // reCAPTCHA chuẩn ghi token vào textarea này.
  tokenSelectors: 'textarea[name="g-recaptcha-response"]',
  anchorIframe: 'iframe[src*="/recaptcha/api2/anchor"]',
  challengeIframe: 'iframe[src*="/recaptcha/api2/bframe"]',

  // Submit điều hướng sang trang kết quả mới.
  submitNavigates: true,

  result: {
    structured: true,
    ready: '#ket-qua',      // vùng kết quả xuất hiện = trang đã trả kết quả
    error: null,
    fields: {
      hoTen: '#kq-hoten',
      thoiHanThe: '#kq-thoihan',
      noiKCB: '#kq-noikcb',
      trangThai: '#kq-trangthai'
    }
  }
};

// ---- TARGET: CỔNG BHXH THẬT ----
// https://baohiemxahoi.gov.vn/tracuu/pages/tra-cuu-thoi-han-su-dung-the-bhyt.aspx
// Selector lấy trực tiếp từ HTML thật của trang (form #frmTheBHYT).
const REAL_TARGET = {
  mode: 'real',
  url: 'https://baohiemxahoi.gov.vn/tracuu/pages/tra-cuu-thoi-han-su-dung-the-bhyt.aspx',

  fields: {
    maso: '#txtMaThe',      // Mã số BHXH/thẻ BHYT
    hoten: '#txtHoTen',     // Họ tên
    ngaysinh: '#txtNgaySinh' // Ngày/năm sinh (dd/mm/yyyy hoặc yyyy)
  },

  submit: '#btnTraCuu',     // nút "Tra cứu"

  // Token nằm ở 2 nơi: hidden input #tokenRecaptch (callback correctCaptcha) + textarea chuẩn.
  // Poll cả hai, lấy giá trị non-empty đầu tiên. LƯU Ý: site gọi grecaptcha.reset()
  // ngay sau submit -> phải đọc token TRƯỚC khi click.
  tokenSelectors: '#tokenRecaptch, textarea[name="g-recaptcha-response"]',
  anchorIframe: 'iframe[src*="/recaptcha/api2/anchor"]',
  challengeIframe: 'iframe[src*="/recaptcha/api2/bframe"]',

  // Submit chạy AJAX ($.post -> pListTheBHYTThe.aspx), KHÔNG điều hướng.
  submitNavigates: false,

  result: {
    parse: 'bhyt',          // parser chuyên cho định dạng #tcContainer của cổng BHXH
    ready: '#tcContainer',  // được đổ HTML khi tra cứu thành công
    error: '#messeger',     // được đổ text khi lỗi/thiếu trường/không tìm thấy
    container: '#tcContainer',
    // Thông điệp kết quả nằm trong 1 span; cổng dùng .hoten (đỏ/xanh dương) hoặc .hieuluc (xanh lá)
    message: '.ketqua-tracuu .hoten, .ketqua-tracuu .hieuluc',
    section: '.ketqua-tracuu fieldset' // các khối: "Thông báo", "Quyền lợi"…
  },

  // Chỉ để tham chiếu (Playwright điều khiển browser thật nên sitekey khớp domain).
  sitekey: '6Lcey5QUAAAAADcB0m7xYLj8W8HHi8ur4JQrTCUY'
};

const MODE = (process.env.TARGET_MODE || 'real').toLowerCase();
export const TARGET = MODE === 'demo' ? DEMO_TARGET : REAL_TARGET;

export const STATES = {
  PENDING: 'PENDING',
  FILLING: 'FILLING',
  AWAIT_CHECKBOX: 'AWAIT_CHECKBOX',
  AWAIT_CHALLENGE: 'AWAIT_CHALLENGE',
  TOKEN_READY: 'TOKEN_READY',
  SUBMITTING: 'SUBMITTING',
  PARSING: 'PARSING',
  DONE: 'DONE',
  FAILED: 'FAILED'
};

// Token reCAPTCHA sống ~2 phút. Cho người thao tác tối đa 120s.
export const TOKEN_TIMEOUT_MS = 120_000;

// Thời gian chờ kết quả AJAX/điều hướng sau khi submit.
export const RESULT_TIMEOUT_MS = 20_000;

// #4 Cứng hoá:
export const MAX_OPEN_RETRIES = Number(process.env.MAX_OPEN_RETRIES || 2);   // mở trang + điền (lỗi mạng/timeout)
export const MAX_CAPTCHA_RETRIES = Number(process.env.MAX_CAPTCHA_RETRIES || 2); // captcha bị từ chối/hết hạn -> giải lại
