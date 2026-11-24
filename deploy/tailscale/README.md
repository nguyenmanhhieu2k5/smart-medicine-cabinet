# Tailscale — kênh quản trị riêng

Ứng dụng Windows (ADMIN) chỉ kết nối tới Mini PC qua tailnet. Cổng Admin `8001` chỉ nghe `127.0.0.1`;
`tailscale serve` đưa nó lên tailnet với HTTPS (`https://<tên-máy>.<tailnet>.ts.net`).

## Thiết lập

1. Trên Mini PC: `deploy\tailscale\setup-tailscale.ps1` (đăng nhập tailnet, bật Unattended, `tailscale serve`).
2. Trên máy Admin: cài Tailscale, đăng nhập **cùng tailnet**.
3. Ứng dụng Windows → *Kết nối máy chủ* → nhập địa chỉ script in ra (vd. `https://minipc.tail1234.ts.net`).

## Giới hạn truy cập (khuyến nghị)

Trong *Access controls* của Tailscale, chỉ cho máy Admin vào cổng 443 của Mini PC, ví dụ:

```json
{
  "tagOwners": { "tag:smc-server": ["autogroup:admin"], "tag:smc-admin": ["autogroup:admin"] },
  "grants": [
    { "src": ["tag:smc-admin"], "dst": ["tag:smc-server"], "ip": ["tcp:443"] }
  ]
}
```

Gắn thẻ `tag:smc-server` cho Mini PC và `tag:smc-admin` cho các máy quản trị trong trang *Machines*.

## Kênh công khai bằng Tailscale Funnel (không cần tên miền)

`deploy\tailscale\setup-funnel.ps1` đưa **chỉ API công khai** (`127.0.0.1:8000`, cho điện thoại + ESP32) ra Internet tại
`https://<tên-máy>.<tailnet>.ts.net:8443`. Cổng 443 (API quản trị) vẫn chỉ trong tailnet.

```
https://<tên-máy>.<tailnet>.ts.net        (443, chỉ tailnet)  → 127.0.0.1:8001  API quản trị
https://<tên-máy>.<tailnet>.ts.net:8443   (Funnel, Internet)  → 127.0.0.1:8000  API công khai
```

- Lần đầu Tailscale yêu cầu duyệt Funnel cho tailnet (liên kết `https://login.tailscale.com/f/funnel?node=…`).
- Nếu gắn thẻ `tag:smc-server` cho Mini PC theo ACL ở trên, thêm quyền Funnel cho thẻ đó trong *Access controls*:
  `"nodeAttrs": [{ "target": ["tag:smc-server"], "attr": ["funnel"] }]`.
- Xem trạng thái: `tailscale funnel status`. Tắt: `setup-funnel.ps1 -Disable`.
  **Không** dùng `tailscale funnel reset` — lệnh đó xóa luôn cấu hình kênh quản trị.

## Lưu ý bảo mật

- Tailscale chỉ là lớp mạng; máy chủ vẫn bắt buộc đăng nhập bằng tài khoản **ADMIN** (JWT `aud=admin`).
- Token Scanner (mobile) không dùng được ở cổng này, kể cả khi tài khoản có vai trò ADMIN.
- Yêu cầu đi qua kênh công khai — Cloudflare (header `CF-Ray`, `CF-Connecting-IP`) hoặc Tailscale Funnel (header
  `Tailscale-Funnel-Request`) — bị cổng Admin từ chối, phòng trường hợp cấu hình nhầm cổng.
- `deploy\windows\health-check.ps1` báo lỗi nếu Funnel trỏ tới bất kỳ đâu ngoài `127.0.0.1:8000`.
