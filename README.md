# MVP RPA BHYT — Playwright + CDP screencast (không Docker/noVNC)

Chứng minh luồng của [kiến trúc](kien-truc-rpa-bhyt.md) chạy thông theo đúng **"đường màu cam"**: stream màn hình browser lên UI, người click captcha **ngay trong UI** — một giao diện duy nhất.

```
FILLING → AWAIT_CHECKBOX → [AWAIT_CHALLENGE] → TOKEN_READY → SUBMITTING → PARSING → DONE
 (RPA điền)   (người click captcha TRONG panel live-view)      (RPA tự submit + bóc kết quả)
```

Live-view dùng **CDP screencast** (mục 4 — Phương án B), chạy native trên Windows:
- `Page.startScreencast` → đẩy frame JPEG lên UI qua WebSocket.
- Thao tác chuột của người trong UI → `Input.dispatchMouseEvent` về browser (giữ quỹ đạo chuột thật cho reCAPTCHA chấm điểm).

> Đã bỏ noVNC + Docker (Phương án A) theo yêu cầu; thay bằng Phương án B để vẫn giữ nguyên tắc "1 UI duy nhất, người click tại chỗ".

## Thành phần

| File | Vai trò |
|---|---|
| `src/config.js` | 2 target (`demo` / `real`) + selector. Chọn bằng `TARGET_MODE`. |
| `src/browser.js` | 1 browser Chrome headful + CDP screencast (stream frame) + dispatch chuột. |
| `src/captcha-handoff.js` | Module handoff captcha từ target site sang Operator UI: focus/crop, challenge, token polling. |
| `src/job.js` | State machine: điền → chờ token captcha → submit → parse. |
| `src/orchestrator.js` | UI + WebSocket (frame ra / input vào), điều phối job. |
| `public/` | UI: form + chip trạng thái + panel live-view (click captcha tại chỗ) + kết quả. |
| `demo-site/server.js` | Site giả lập cổng BHXH (reCAPTCHA test key) cho mode `demo`. |

## Yêu cầu

- Node.js (đã có v26) + `npm install` (đã chạy).
- Chromium của Playwright: `npx playwright install chromium` (đã chạy).

## Chạy

```powershell
cd D:\AI\VSF\Auto_fill

# (khuyến nghị thử trước) mode demo — an toàn, không đụng cổng thật:
$env:TARGET_MODE="demo"; npm start

# hoặc cổng BHXH thật:
$env:TARGET_MODE="real"; npm start
```

### Chế độ hiển thị browser (`BROWSER_VIEW`)

| `BROWSER_VIEW` | Hành vi | Ghi chú |
|---|---|---|
| `app` (mặc định) | **Headless — không mở cửa sổ nào**, chỉ stream vào app | Ưu tiên Playwright headless-shell nếu có; có thể bị reCAPTCHA đố hình nhiều hơn (người vẫn giải trong app) |
| `hidden` | Headful nhưng cửa sổ nằm ngoài màn hình | Ít bị captcha hơn, vẫn không thấy cửa sổ |
| `desktop` | Headful, hiện cửa sổ | Để debug |

```powershell
# ví dụ: chạy thật, ẩn cửa sổ ngoài màn hình (ít captcha hơn headless)
$env:TARGET_MODE="real"; $env:BROWSER_VIEW="hidden"; npm start
```

## #3 — Làm ấm profile + quản IP

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `PROFILE_DIR` | `./.profile` | Profile bền (cookie + điểm tin cậy reCAPTCHA giữ qua các lần chạy → **ít đố hình dần**). |
| `PROXY_SERVER` | (none) | IP ra ngoài, vd `http://ip:port` hoặc `socks5://ip:port`. **Nên dùng residential/business**, tránh datacenter. |
| `PROXY_USERNAME` / `PROXY_PASSWORD` | (none) | Xác thực proxy nếu cần. |
| `BROWSER_LOCALE` / `BROWSER_TZ` | `vi-VN` / `Asia/Ho_Chi_Minh` | Đồng bộ ngôn ngữ/múi giờ VN, giảm dấu vết. |

```powershell
# ví dụ: profile riêng + proxy residential
$env:TARGET_MODE="real"; $env:PROFILE_DIR="D:\bhyt-profile"; $env:PROXY_SERVER="http://user:pass@ip:port"; npm start
```

> ⚠️ `PROFILE_DIR` chứa cookie/phiên → **dữ liệu nhạy cảm**, bảo vệ như bí mật. Càng chạy nhiều trên cùng profile + IP sạch, tỉ lệ chỉ-1-click càng cao.

## #4 — Cứng hoá

| Cơ chế | Cấu hình | Hành vi |
|---|---|---|
| **Retry mở trang** | `MAX_OPEN_RETRIES` (2) | Lỗi mạng/timeout khi mở+điền → tự thử lại. |
| **Phục hồi captcha** | `MAX_CAPTCHA_RETRIES` (2) | Captcha bị từ chối/hết hạn → tự `grecaptcha.reset()` + mời click lại. |
| **Cảnh báo đổi layout** | — | Thiếu selector cốt lõi → báo `LAYOUT_CHANGED` + ghi `logs/dead-letter.log` (không PII). |
| **Token hết hạn** | `TOKEN_TIMEOUT_MS` (120s) | Chờ tối đa 120s; submit ngay khi có token để token còn sống. |
| **Mã hoá PII** | `RESULT_LOG_KEY` | Nếu đặt → lưu kết quả **đã mã hoá AES-256-GCM** vào `logs/results.enc.jsonl`. Không đặt → **không lưu gì** (mặc định an toàn). |

```powershell
# bật lưu kết quả mã hoá, rồi giải mã để xem
$env:RESULT_LOG_KEY="chuoi-bi-mat-cua-ban"; npm start
# ... sau đó:
$env:RESULT_LOG_KEY="chuoi-bi-mat-cua-ban"; npm run decrypt-results
```

> PII (mã BHXH/tên/ngày sinh) **không bao giờ** ghi ra console/log thường. `logs/` và `.profile/` cần được bảo vệ/loại khỏi mọi nơi chia sẻ.

Mở **http://localhost:3000**:

1. Nhập dữ liệu → bấm **"Bắt đầu — RPA điền form"**.
2. Panel live-view bên phải hiện browser đang tự điền 3 trường. Trạng thái dừng ở **AWAIT_CHECKBOX**.
3. Click **"I'm not a robot"** **ngay trong panel live-view** (giải hình nếu Google bắt → chip **AWAIT_CHALLENGE**).
4. Có token → RPA tự **submit** → **parse** → kết quả hiện ở cột trái.

## Hai target — chọn bằng `TARGET_MODE`

| `TARGET_MODE` | Đích | Ghi chú |
|---|---|---|
| `real` (mặc định) | **Cổng BHXH thật** `tra-cuu-thoi-han-su-dung-the-bhyt.aspx` | Submit chạy AJAX, kết quả đổ vào `#tcContainer`. |
| `demo` | Site giả lập nội bộ | reCAPTCHA test key, không đụng PII/ToS. |

### Selector cổng BHXH thật (đã cắm trong `src/config.js`)

| Trường | Selector |
|---|---|
| Mã số BHXH/thẻ | `#txtMaThe` |
| Họ tên | `#txtHoTen` |
| Ngày/năm sinh | `#txtNgaySinh` (dd/mm/yyyy hoặc yyyy) |
| Nút Tra cứu | `#btnTraCuu` |
| Token captcha (site) | `#tokenRecaptch` + `textarea[name=g-recaptcha-response]` |
| Vùng kết quả | `#tcContainer` (inject qua AJAX) |
| Lỗi/không tìm thấy | `#messeger` |
| Sitekey | `6Lcey5QUAAAAADcB0m7xYLj8W8HHi8ur4JQrTCUY` |

### Còn cần 1 mẫu kết quả thật
Cấu trúc HTML bên trong `#tcContainer` chỉ sinh ra sau một lần tra cứu thành công, nên parser đang trả **raw text + html** của cả container (`result.structured = false`). Khi có một ca thật, gửi tôi HTML trong `#tcContainer` → tôi thêm selector từng trường (thời hạn thẻ, nơi KCB…) và bật `structured: true`.

## Ghi chú

- Không cho Playwright tự click checkbox (bị đo quỹ đạo chuột) — người click thật trong panel live-view, thao tác được chuyển về browser qua CDP.
- Cửa sổ Chrome vẫn hiện trên desktop (headful) nhưng bạn **không cần đụng vào** — thao tác hết trong UI. (Sau này chạy trên server không màn hình sẽ dùng Xvfb/headless.)
- Token reCAPTCHA sống ~2 phút, dùng 1 lần → có token là submit ngay (`TOKEN_TIMEOUT_MS = 120s`).
- MVP xử lý **1 job / lần** (1 session). Gửi job mới khi job trước xong.
- Dữ liệu thật là PII (mã BHXH/tên/ngày sinh): hạn chế lưu, mã hóa at-rest khi mở rộng.
