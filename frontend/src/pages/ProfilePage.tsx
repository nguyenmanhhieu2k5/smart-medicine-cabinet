import { useQueryClient } from "@tanstack/react-query";
import { Camera, ChevronRight, Cloud, CloudOff, LogIn, LogOut, Save, Trash2, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PrimaryButton } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field, TextInput } from "@/components/Form";
import { Note } from "@/components/MedicineBits";
import { LoadingState } from "@/components/States";
import { StatusIndicator } from "@/components/StatusIndicator";
import { useLanguageStore, useT } from "@/i18n";
import { api, assetUrl } from "@/services/api";
import { formatNumber } from "@/services/format";
import { errorMessage, keys, useCabinetSummary, useDevice, useHealth, useProfile } from "@/services/queries";
import { usePageHeader } from "@/stores/page";
import { toast } from "@/stores/toast";

export function ProfilePage() {
  const t = useT();
  const navigate = useNavigate();
  const client = useQueryClient();
  const language = useLanguageStore((state) => state.language);
  usePageHeader(t("Hồ sơ"), t("Thông tin người dùng"), `${t("Tủ thuốc thông minh")} / ${t("Hồ sơ")}`);
  const profile = useProfile();
  const device = useDevice().data;
  const health = useHealth().data;
  const summary = useCabinetSummary().data;
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ name: "", email: "", role: "" });
  const [login, setLogin] = useState({ email: "", password: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const data = profile.data;

  useEffect(() => {
    if (data) setForm({ name: data.name, email: data.email, role: data.role });
  }, [data]);

  const run = async (label: string, action: () => Promise<unknown>, success: string) => {
    setBusy(label);
    try {
      await action();
      await client.invalidateQueries({ queryKey: keys.profile });
      toast.success(success);
    } catch (error) {
      toast.error(t("Không thực hiện được"), errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const emailValid = form.email.trim() === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim());
  const dirty = data !== undefined && (form.name !== data.name || form.email !== data.email || form.role !== data.role);

  if (profile.isLoading || !data) return <Card padding="lg"><LoadingState rows={5} /></Card>;

  return (
    <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-6 short:gap-4">
      <Card padding="lg">
        <div className="flex flex-col items-center text-center">
          <div className="relative">
            <span className="flex size-[112px] items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-[#a5cdfc] to-[#5e9ff3] text-white short:size-24">
              {data.has_avatar
                ? <img src={assetUrl("/profile/avatar", avatarVersion)} alt={t("Ảnh đại diện")} className="size-full object-cover" />
                : <User size={40} strokeWidth={1.7} />}
            </span>
            <button type="button" aria-label={t("Đổi ảnh đại diện")} title={t("Đổi ảnh đại diện")} onClick={() => fileRef.current?.click()}
              className="absolute -bottom-1 -right-1 inline-flex size-10 items-center justify-center rounded-full bg-surface text-navy shadow-card ring-1 ring-line transition hover:text-primary">
              <Camera size={17} />
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void run("avatar", () => api.avatarUpload(file).then(() => setAvatarVersion((v) => v + 1)), t("Đã cập nhật ảnh đại diện"));
              }} />
          </div>
          <h2 className="mt-4 font-display text-[26px] font-extrabold text-navy">{data.name || t("Chưa đặt tên")}</h2>
          <p className="text-[15px] text-muted">{t("Người sử dụng tủ thuốc")}</p>
          {data.has_avatar && (
            <PrimaryButton variant="ghost" size="sm" icon={Trash2} className="mt-1" loading={busy === "avatar-delete"}
              onClick={() => void run("avatar-delete", () => api.avatarDelete(), t("Đã xóa ảnh đại diện"))}>{t("Xóa ảnh")}</PrimaryButton>
          )}
        </div>
        <form className="mt-6 space-y-5 short:mt-4 short:space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (emailValid) void run("save", () => api.profileUpdate({ name: form.name.trim(), email: form.email.trim(), role: form.role.trim() }), t("Đã lưu hồ sơ"));
          }}>
          <Field label={t("Họ và tên")}><TextInput value={form.name} maxLength={80} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t("Tên hiển thị trên Trang chủ")} className="!h-[52px]" /></Field>
          <Field label="Email" error={emailValid ? null : t("Email không hợp lệ.")}><TextInput type="email" value={form.email} maxLength={120} onChange={(event) => setForm({ ...form, email: event.target.value })} className="!h-[52px]" /></Field>
          <Field label={t("Vai trò")}><TextInput value={form.role} maxLength={60} onChange={(event) => setForm({ ...form, role: event.target.value })} className="!h-[52px]" /></Field>
          <PrimaryButton type="submit" size="lg" block icon={Save} loading={busy === "save"} disabled={!dirty || !emailValid}>{t("Lưu thay đổi")}</PrimaryButton>
        </form>
      </Card>

      <div className="flex flex-col gap-5 short:gap-4">
        <Card padding="lg">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-display text-[19px] font-bold text-navy">{t("Tài khoản")}</h2>
            {data.auth.signed_in
              ? <StatusIndicator tone="success" icon={Cloud} size="sm">{t("Đã đăng nhập cloud")}</StatusIndicator>
              : <StatusIndicator tone="neutral" icon={CloudOff} size="sm">{t("Hồ sơ cục bộ")}</StatusIndicator>}
          </div>
          {data.auth.signed_in ? (
            <>
              <p className="text-sm text-muted">{t("Đang đăng nhập bằng")} <span className="font-semibold text-navy">{data.auth.email}</span> (Supabase).</p>
              <PrimaryButton variant="secondary" block className="mt-4" icon={LogOut} loading={busy === "logout"}
                onClick={() => void run("logout", () => api.logout(), t("Đã đăng xuất"))}>{t("Đăng xuất")}</PrimaryButton>
            </>
          ) : data.auth.configured ? (
            <form className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run("login", () => api.login(login.email.trim(), login.password).then(() => setLogin({ email: "", password: "" })), t("Đăng nhập thành công"));
              }}>
              <p className="text-sm text-muted">{t("Đăng nhập tài khoản Supabase đã cấu hình cho ứng dụng.")}</p>
              <TextInput type="email" required placeholder="Email" value={login.email} autoComplete="username" onChange={(event) => setLogin({ ...login, email: event.target.value })} />
              <TextInput type="password" required placeholder={t("Mật khẩu")} value={login.password} autoComplete="current-password" onChange={(event) => setLogin({ ...login, password: event.target.value })} />
              <PrimaryButton type="submit" block icon={LogIn} loading={busy === "login"}>{t("Đăng nhập")}</PrimaryButton>
            </form>
          ) : (
            <Note>
              {t("Ứng dụng đang dùng hồ sơ cục bộ, dữ liệu chỉ lưu trên máy này và không cần mật khẩu. Đăng nhập cloud (Supabase Auth) chưa được cấu hình: đặt biến môi trường SUPABASE_URL và SUPABASE_ANON_KEY rồi khởi động lại để bật.")}
            </Note>
          )}
        </Card>

        <Card padding="lg">
          <h2 className="mb-2 font-display text-[19px] font-bold text-navy">{t("Thông tin thiết bị")}</h2>
          <dl className="divide-y divide-line">
            <div className="flex items-center justify-between py-3.5">
              <dt className="text-sm text-muted">{t("Thiết bị")}</dt>
              <dd className="font-display text-[16px] font-bold text-navy">{t("Tủ thuốc thông minh")}</dd>
            </div>
            <div className="flex items-center justify-between py-3.5">
              <dt className="text-sm text-muted">{t("Kết nối ESP32")}</dt>
              <dd>
                {device?.state === "connected"
                  ? <StatusIndicator tone="success" size="sm">{t("Đang kết nối")}{device.simulated ? ` · ${t("Mô phỏng")}` : ""}</StatusIndicator>
                  : device?.enabled
                    ? <StatusIndicator tone="warning" size="sm">{t(device.environment.label)}</StatusIndicator>
                    : <StatusIndicator tone="neutral" size="sm">{t("Chưa kết nối")}</StatusIndicator>}
              </dd>
            </div>
            <div className="flex items-center justify-between py-3.5">
              <dt className="text-sm text-muted">{t("Danh mục thuốc")}</dt>
              <dd className="font-display text-[16px] font-bold tabular-nums text-navy">{health ? t("{count} thuốc", { count: formatNumber(health.catalog_count, language) }) : "—"}</dd>
            </div>
            <div className="flex items-center justify-between py-3.5">
              <dt className="text-sm text-muted">{t("Thuốc trong tủ")}</dt>
              <dd className="font-display text-[16px] font-bold tabular-nums text-navy">{summary ? t("{count} thuốc", { count: summary.counts.all }) : "—"}</dd>
            </div>
          </dl>
          <PrimaryButton variant="secondary" size="lg" block className="mt-4" iconRight={ChevronRight} onClick={() => navigate("/settings")}>{t("Mở cài đặt")}</PrimaryButton>
        </Card>
      </div>
    </div>
  );
}
