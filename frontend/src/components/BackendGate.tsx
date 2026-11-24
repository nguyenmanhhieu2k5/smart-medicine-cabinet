import { LoaderCircle, LogIn, LogOut, RotateCw, Server, TriangleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PrimaryButton } from "@/components/Button";
import { Field, TextInput } from "@/components/Form";
import { useT } from "@/i18n";
import { connection, onConnectionChange } from "@/services/api";
import type { BackendInfo } from "@/types/desktop";

/** Khung chung của màn hình kết nối (giữ nguyên kiểu thẻ khởi động của bản desktop cũ). */
function GateCard({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="app-backdrop flex h-screen w-screen items-center justify-center overflow-y-auto p-8" data-testid="backend-gate">
      <div className="flex w-full max-w-[520px] flex-col items-center rounded-card bg-surface px-10 py-12 text-center shadow-card ring-1 ring-line">
        <img src="./favicon.svg" alt="" className="mb-6 size-[72px] rounded-[20px] shadow-button" />
        <p className="font-display text-[22px] font-extrabold tracking-tight text-navy">{t("Tủ thuốc thông minh")}</p>
        <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">Smart Medicine Cabinet · Admin</p>
        {children}
      </div>
    </div>
  );
}

function ErrorText({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-4 w-full rounded-xl bg-danger-soft px-3.5 py-2.5 text-left text-[13px] font-medium text-danger">
      {message}
    </p>
  );
}

function ServerForm({ info, onDone }: { info: BackendInfo; onDone: (info: BackendInfo) => void }) {
  const t = useT();
  const [url, setUrl] = useState(info.baseUrl || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const next = await connection.setServer(url).catch((e: unknown) => ({ ...info, error: e instanceof Error ? e.message : String(e) }));
    setBusy(false);
    if (next.error) setError(next.error);
    else onDone(next);
  };
  return (
    <form className="mt-8 w-full text-left" onSubmit={submit}>
      <p className="mb-4 text-center font-display text-[17px] font-bold text-navy">{t("Kết nối máy chủ Mini PC")}</p>
      <Field label={t("Địa chỉ API quản trị")} hint={t("Địa chỉ Tailscale của Mini PC, ví dụ https://mini-pc.ten-tailnet.ts.net. Khi dùng ngay trên Mini PC: http://127.0.0.1:8001")}>
        <TextInput value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mini-pc.ten-tailnet.ts.net" autoFocus
          spellCheck={false} autoComplete="url" maxLength={300} aria-label={t("Địa chỉ API quản trị")} />
      </Field>
      <ErrorText message={error} />
      <PrimaryButton type="submit" icon={Server} block className="mt-6" loading={busy} disabled={!url.trim()}>{t("Kết nối")}</PrimaryButton>
      <p className="mt-4 text-center text-[12.5px] text-muted">{t("Máy Windows không cần chung mạng Wi-Fi với Mini PC — chỉ cần cùng tài khoản Tailscale.")}</p>
    </form>
  );
}

/** Đăng nhập — địa chỉ máy chủ được ứng dụng tự chọn (gài sẵn, như ứng dụng điện thoại) nên không hiện ở đây. */
function LoginForm({ info }: { info: BackendInfo }) {
  const t = useT();
  const [email, setEmail] = useState(info.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(info.error ?? null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const next = await connection.login(email.trim(), password).catch((e: unknown) => ({ ...info, error: e instanceof Error ? e.message : String(e) }));
    setBusy(false);
    if (next.state !== "ready") {
      setError(next.error ?? t("Đăng nhập thất bại."));
      setPassword("");
    }
  };
  return (
    <form className="mt-8 w-full text-left" onSubmit={submit}>
      <p className="mb-5 text-center font-display text-[17px] font-bold text-navy">{t("Đăng nhập quản trị")}</p>
      <div className="space-y-4">
        <Field label={t("Email")}>
          <TextInput type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" autoFocus={!email}
            maxLength={254} aria-label={t("Email")} />
        </Field>
        <Field label={t("Mật khẩu")}>
          <TextInput type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password"
            autoFocus={Boolean(email)} maxLength={200} aria-label={t("Mật khẩu")} />
        </Field>
      </div>
      <ErrorText message={error} />
      <PrimaryButton type="submit" icon={LogIn} block className="mt-6" loading={busy} disabled={!email.trim() || !password}>{t("Đăng nhập")}</PrimaryButton>
      <p className="mt-4 text-center text-[12.5px] text-muted">{t("Chỉ tài khoản Quản trị viên (ADMIN). Tài khoản Scanner dùng ứng dụng điện thoại.")}</p>
      {info.secureStorage === false && (
        <p className="mt-2 text-center text-[12px] text-warning-ink">{t("Windows không hỗ trợ mã hóa phiên: bạn sẽ phải đăng nhập lại mỗi lần mở ứng dụng.")}</p>
      )}
    </form>
  );
}

/**
 * Cổng kết nối của ứng dụng quản trị:
 *  - địa chỉ máy chủ được tự chọn từ danh sách gài sẵn (desktop/servers.json), như ứng dụng điện thoại;
 *  - không kết nối được → nêu rõ (bật Tailscale), cho Thử lại hoặc Đổi máy chủ (nhập tay, chỉ khi cần);
 *  - chưa đăng nhập / phiên hết hạn → đăng nhập Admin;
 *  - có phiên nhưng không tới được máy chủ → nêu rõ lỗi, cho thử lại (không giả vờ là đã kết nối);
 *  - sẵn sàng → hiển thị ứng dụng.
 */
export function BackendGate({ children }: { children: ReactNode }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [info, setInfo] = useState<BackendInfo | null>(null);
  const [editServer, setEditServer] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const off = onConnectionChange((next) => {
      if (!cancelled) setInfo(next);
    });
    connection
      .init()
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setInfo({ state: "error", baseUrl: "", token: "", error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const ready = info?.state === "ready";
  useEffect(() => {
    if (info && !ready) queryClient.clear(); // đăng xuất / hết phiên → bỏ dữ liệu của phiên cũ
  }, [info, ready, queryClient]);

  if (ready && !editServer) return <>{children}</>;

  if (info === null) {
    return (
      <GateCard>
        <div className="mt-9 flex flex-col items-center gap-3" role="status">
          <LoaderCircle size={26} className="animate-spin text-primary" />
          <p className="text-sm font-medium text-navy">{t("Đang kết nối máy chủ…")}</p>
          <p className="max-w-sm text-[13px] text-muted">{t("Dữ liệu thuốc, người dùng và thiết bị nằm trên máy chủ Mini PC (PostgreSQL).")}</p>
        </div>
      </GateCard>
    );
  }

  if (info.state === "unconfigured" || editServer) {
    return (
      <GateCard>
        <ServerForm info={info} onDone={() => setEditServer(false)} />
      </GateCard>
    );
  }

  if (info.state === "error") {
    const retry = async () => {
      setRetrying(true);
      await connection.retry().catch(() => undefined);
      setRetrying(false);
    };
    return (
      <GateCard>
        <div className="mt-8 flex w-full flex-col items-center" role="alert">
          <span className="mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <TriangleAlert size={24} />
          </span>
          <p className="font-display text-[17px] font-bold text-navy">{t("Không kết nối được máy chủ")}</p>
          <p className="mt-2 break-words text-[13.5px] text-muted">{info.error}</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <PrimaryButton icon={RotateCw} loading={retrying} onClick={() => void retry()}>{t("Thử lại")}</PrimaryButton>
            <PrimaryButton variant="secondary" icon={Server} onClick={() => setEditServer(true)}>{t("Đổi máy chủ")}</PrimaryButton>
            {info.hasSession !== false && (
              <PrimaryButton variant="ghost" icon={LogOut} onClick={() => void connection.logout()}>{t("Đăng xuất")}</PrimaryButton>
            )}
          </div>
        </div>
      </GateCard>
    );
  }

  return (
    <GateCard>
      <LoginForm key={info.baseUrl} info={info} />
    </GateCard>
  );
}
