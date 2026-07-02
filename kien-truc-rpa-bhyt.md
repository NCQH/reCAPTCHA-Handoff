# Kiến trúc RPA + Human-in-the-loop cho tra cứu BHYT (reCAPTCHA v2)

> Mục tiêu: người vận hành chỉ thao tác trên **một** giao diện duy nhất. RPA (Playwright) tự điền dữ liệu và submit trên cổng BHXH; con người chỉ chạm vào đúng bước reCAPTCHA v2, ngay bên trong UI của bạn.

Đã xác định captcha trên trang là **reCAPTCHA v2 checkbox** ("I'm not a robot", có fallback đố hình) — token gắn với domain + session + IP, hiệu lực ~2 phút, dùng một lần. Đây là ràng buộc chi phối toàn bộ kiến trúc.

---

## 1. Nguyên tắc nền tảng (quyết định mọi thứ)

1. **Một session — một IP — một browser.** Browser điền form, browser người click captcha, và browser submit **phải là cùng một instance**, cùng cookie, cùng IP. Đây là lý do gốc để *stream browser server ra người*, thay vì cố "bê captcha" đi nơi khác.
2. **Không nhúng iframe captcha riêng.** reCAPTCHA v2 kiểm tra domain qua sitekey → nhúng lên domain khác sẽ báo *"Invalid domain for site key"*. Bỏ hẳn ý tưởng này.
3. **Không để Playwright tự click checkbox.** reCAPTCHA đo quỹ đạo chuột + timing → bot tự click sẽ bị đẩy sang đố hình khó hoặc trượt điểm. Người click thật.
4. **Chỉ kích captcha ngay trước khi submit.** Token sống ~2 phút, dùng một lần → không giải trước, giải xong submit ngay.
5. **Browser "ấm", IP sạch.** Profile bền (userDataDir) + IP ổn định (ưu tiên residential/business, tránh datacenter) → điểm rủi ro thấp → phần lớn lượt chỉ cần 1 click, không hiện đố hình.

---

## 2. Các thành phần

| Thành phần | Vai trò | Gợi ý công nghệ |
|---|---|---|
| **Operator UI** | Giao diện DUY NHẤT: nhập/nhận yêu cầu, panel live-view để click captcha, hiển thị kết quả | React + WebSocket |
| **Orchestrator / Backend API** | Nhận yêu cầu, quản lý hàng đợi, điều phối session & bước captcha | Node (Fastify) hoặc Python (FastAPI) |
| **Browser Worker Pool** | Nhiều instance Playwright headful, mỗi cái giữ 1 session, điều khiển qua CDP | Playwright + Docker + Xvfb |
| **Live-view / Streaming** | Đưa màn hình browser thật lên UI + chuyển thao tác chuột/phím của người về browser | noVNC **hoặc** CDP screencast |
| **Queue + State store** | Hàng đợi job, trạng thái session, khóa worker | Redis (BullMQ / Celery) |
| **Data store** | Lưu yêu cầu & kết quả có cấu trúc | PostgreSQL |
| **Result parser** | Bóc kết quả (thời hạn thẻ, nơi KCB…) thành JSON | Playwright selector |

---

## 3. Vòng đời một yêu cầu (state machine)

```
PENDING → FILLING → AWAIT_CHECKBOX → [AWAIT_CHALLENGE] → TOKEN_READY → SUBMITTING → PARSING → DONE
                                                                              ↘ (lỗi) → RETRY / FAILED
```

1. **PENDING** — Operator (hoặc hệ thống upstream qua API) gửi `{mã số BHXH, họ tên, ngày sinh}`. Backend enqueue vào Redis.
2. **FILLING** — Một worker rảnh nhận job, mở/tái dùng browser context ấm, mở trang tra cứu, Playwright tự điền 3 trường (không cần người).
3. **AWAIT_CHECKBOX** — Worker phát hiện cần captcha → set trạng thái `NEEDS_CAPTCHA`, báo backend. Backend đẩy live-view của **đúng worker này** lên Operator UI.
4. **AWAIT_CHALLENGE** (nếu có) — Người click "I'm not a robot" trong live-view; nếu Google bắt giải hình thì người giải luôn tại chỗ.
5. **TOKEN_READY** — Worker poll thấy `textarea.g-recaptcha-response` đã có token → tự click "Tra cứu"/submit.
6. **SUBMITTING → PARSING** — Trang trả kết quả, worker bóc tách dữ liệu.
7. **DONE** — UI hiển thị kết quả có cấu trúc; worker trả browser về pool idle hoặc tái tạo context.

**Cách worker "biết" trạng thái captcha:** poll trong page —
- `textarea.g-recaptcha-response` có giá trị? → token đã sẵn.
- iframe `/recaptcha/api2/bframe` đang hiển thị? → đang ở bước đố hình.

---

## 4. Lớp streaming — chọn 1 trong 2

### Phương án A — noVNC (nhanh dựng, chắc chắn)
Browser chạy trong container kèm **Xvfb + x11vnc + websockify**. Operator UI nhúng client noVNC (thư viện JS hoặc iframe). Chuột/phím của người → VNC → browser thật.
- **Ưu:** hoạt động với mọi browser, ổn định, thấy toàn bộ.
- **Nhược:** tốn băng thông hơn (stream cả framebuffer); nên giới hạn vùng thao tác/chỉ mở khi tới bước captcha.

### Phương án B — CDP screencast (gọn, native)
Dùng `Page.startScreencast` của CDP để stream frame JPEG; chuyển click về bằng `Input.dispatchMouseEvent`. Có thể **crop đúng vùng captcha**, băng thông thấp, nhúng như một widget gọn trong UI.
- **Ưu:** nhẹ, kiểm soát tốt, UI đẹp.
- **Nhược:** phải tự dựng nhiều plumbing hơn. (Popup đố hình là iframe cross-origin nhưng CDP dispatch ở tầng browser nên vẫn bắt input bình thường.)

### Phương án C — Browser-as-a-Service (Browserbase / Steel.dev / browserless)
Cung cấp sẵn browser headful + live-view iframe + điều khiển CDP (`chromium.connectOverCDP(wsEndpoint)`). Bỏ được hạ tầng.
- **Cảnh báo PII:** dữ liệu CCCD/tên/ngày sinh là dữ liệu cá nhân của công dân VN — đẩy qua bên thứ ba cần cân nhắc pháp lý & nơi lưu trú dữ liệu. Với PII, **ưu tiên tự host noVNC/CDP** (A hoặc B).

---

## 5. Mô hình đồng thời (tối ưu thông lượng)

Nút cổ chai là **con người ở bước captcha**, không phải máy. Thiết kế để 1 người phục vụ cả hàng đợi:

- Pool **N** worker ấm chạy song song: nhiều browser cùng lúc *pre-fill* form và đứng chờ ở `AWAIT_CHECKBOX`.
- Backend đẩy lần lượt từng worker "đã sẵn captcha" ra cho người vận hành → người **chỉ click captcha nối tiếp nhau**, không phải chờ máy điền.
- Ví dụ: 5 browser điền sẵn → người click 5 captcha liên tục → thông lượng cao hơn nhiều so với tuần tự.

---

## 6. Xử lý lỗi & biên

| Tình huống | Xử lý |
|---|---|
| Token hết hạn (người thao tác chậm >2 phút) | Reload widget captcha, quay lại `AWAIT_CHECKBOX`, đếm số lần thử |
| Session timeout của cổng BHXH | Tái tạo context, chạy lại job |
| Google đẩy đố hình liên tục | Dấu hiệu IP/điểm rủi ro xấu → xoay/đổi IP, làm ấm profile |
| Không tìm thấy kết quả | Phân biệt "sai thông tin" vs "lỗi hệ thống", trả mã lỗi rõ ràng |
| Trang đổi layout/selector | Cảnh báo, dead-letter queue, alert cho dev |

---

## 7. Bảo mật & tuân thủ

- **PII:** mã hóa at-rest, giảm thời gian lưu, hạn chế truyền qua bên thứ ba (nghiêng về tự host).
- **Tần suất:** tôn trọng giới hạn của cổng, đặt mức đồng thời hợp lý để tránh bị chặn IP.
- **Điều khoản dịch vụ:** rà lại ToS của BHXH. Human-in-the-loop là hướng "sạch" nhất (vẫn có người thật giải captcha) nhưng **khối lượng** vẫn là yếu tố quyết định rủi ro.

---

## 8. Stack đề xuất (khởi động nhanh)

- **Backend:** Node.js + Fastify (hoặc Python + FastAPI)
- **Điều khiển browser:** Playwright, headful trong Docker + Xvfb
- **Streaming:** noVNC (x11vnc + websockify) cho bản chạy nhanh; nâng cấp CDP screencast sau
- **Queue:** Redis + BullMQ (Node) / Celery (Python)
- **DB:** PostgreSQL
- **Frontend:** React — form nhập + panel live-view + màn kết quả + danh sách hàng đợi
- **Triển khai:** Docker Compose (hoặc K8s), mỗi worker = 1 container browser

---

## 9. Lộ trình dựng dần (MVP → hoàn chỉnh)

1. **MVP 1 session:** Playwright headful local + noVNC + 1 form web. Chứng minh luồng điền → người click captcha → submit → parse kết quả chạy thông.
2. **Thêm queue + state machine:** tách backend, Redis, trạng thái job.
3. **Pool nhiều worker + UI hàng đợi:** 1 người phục vụ nhiều browser.
4. **Làm ấm profile + quản IP:** giảm tỉ lệ đố hình.
5. **Cứng hóa:** retry, xử lý token hết hạn, alert khi đổi layout, mã hóa PII.
