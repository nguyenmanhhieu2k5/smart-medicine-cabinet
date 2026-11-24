import { useQueryClient } from "@tanstack/react-query";
import { Camera, ChevronRight, KeyRound, LogOut, Save, Server, ShieldCheck, Trash2, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PrimaryButton } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field, TextInput } from "@/components/Form";
import { Note } from "@/components/MedicineBits";
import { Modal } from "@/components/Modal";
import { LoadingState } from "@/components/States";
import { StatusIndicator } from "@/components/StatusIndicator";
import { useLanguageStore, useT } from "@/i18n";
import { api, assetUrl, connection, connectionInfo } from "@/services/api";
import { formatDateTime, formatNumber } from "@/services/format";
import { errorMessage, keys, useCabinetSummary, useDevice, useHealth, useProfile } from "@/services/queries";
import { usePageHeader } from "@/stores/page";
import { toast } from "@/stores/toast";

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm({ current: "", next: "", confirm: "" });
      setError(null);
    }
  }, [open]);
  const mismatch = form.confirm !== "" && form.next !== form.confirm;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(form.current, form.next);
      toast.success(t("Đã đổi mật khẩu"), t("Các phiên đăng nhập khác của tài khoản đã bị đăng xuất."));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Đổi mật khẩu")} size="sm"
      footer={
        <>
          <PrimaryButton variant="secondary" onClick={onClose}>{t("Hủy")}</PrimaryButton>
          <PrimaryButton icon={KeyRound} loading={busy} disabled={!form.current || !form.next || form.next !== form.confirm} onClick={() => void submit()}>{t("Đổi mật khẩu")}</PrimaryButton>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t("Mật khẩu hiện tại")}><TextInput type="password" autoComplete="current-password" value={form.current} maxLength={200} onChange={(event) => setForm({ ...form, current: event.target.value })} /></Field>
        <Field label={t("Mật khẩu mới")} hint={t("Ít nhất 8 ký tự, gồm cả chữ và số.")}><TextInput type="password" autoComplete="new-password" value={form.next} maxLength={200} onChange={(event) => setForm({ ...form, next: event.target.value })} /></Field>
        <Field label={t("Nhập lại mật khẩu mới")} error={mismatch ? t("Mật khẩu nhập lại không khớp.") : null}><TextInput type="password" autoComplete="new-password" value={form.confirm} maxLength={200} onChange={(event) => setForm({ ...form, confirm: event.target.value })} /></Field>
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">{error}</p>}
      </div>
    </Modal>
  );
}

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
  const [form, setForm] = useState({ name: "", phone: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const data = profile.data;
  const server = connectionInfo().baseUrl;

  useEffect(() => {
    if (data) setForm({ name: data.name, phone: data.phone ?? "" });
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

  const dirty = data !== undefined && (form.name !== data.name || form.phone !== (data.phone ?? ""));

  if (profile.isLoading || !data) return <Card padding="lg"><LoadingState rows={5} /></Card>;

  return (
    <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-6 short:gap-4">
      <Card padding="lg">
        <div className="flex flex-col items-center text-center">
          <div className="relative">
            <span className="flex size-[112px] items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-[#99c2ff] to-[#0066ff] text-white short:size-24">
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
          <p className="text-[15px] text-muted">{t("Quản trị viên tủ thuốc")}</p>
          {data.has_avatar && (
            <PrimaryButton variant="ghost" size="sm" icon={Trash2} className="mt-1" loading={busy === "avatar-delete"}
              onClick={() => void run("avatar-delete", () => api.avatarDelete(), t("Đã xóa ảnh đại diện"))}>{t("Xóa ảnh")}</PrimaryButton>
          )}
        </div>
        <form className="mt-6 space-y-5 short:mt-4 short:space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run("save", () => api.profileUpdate({ name: form.name.trim(), phone: form.phone.trim() || null }), t("Đã lưu hồ sơ"));
          }}>
          <Field label={t("Họ và tên")}><TextInput value={form.name} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t("Tên hiển thị trên Trang chủ")} className="!h-[52px]" /></Field>
          <Field label="Email" hint={t("Email đăng nhập do quản trị viên quản lý trong mục Quản trị → Tài khoản.")}><TextInput type="email" value={data.email} readOnly disabled className="!h-[52px]" /></Field>
          <Field label={t("Số điện thoại")}><TextInput type="tel" value={form.phone} maxLength={32} onChange={(event) => setForm({ ...form, phone: event.target.value })} className="!h-[52px]" /></Field>
          <PrimaryButton type="submit" size="lg" block icon={Save} loading={busy === "save"} disabled={!dirty}>{t("Lưu thay đổi")}</PrimaryButton>
        </form>
      </Card>

      <div className="flex flex-col gap-5 short:gap-4">
        <Card padding="lg">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-display text-[19px] font-bold text-navy">{t("Tài khoản")}</h2>
            <StatusIndicator tone="success" icon={ShieldCheck} size="sm">{data.account.role_name ?? data.account.role}</StatusIndicator>
          </div>
          <dl className="divide-y divide-line">
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-sm text-muted">{t("Đăng nhập bằng")}</dt>
              <dd className="truncate text-sm font-semibold text-navy">{data.account.email}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="flex items-center gap-1.5 text-sm text-muted"><Server size={14} />{t("Máy chủ")}</dt>
              <dd className="truncate text-sm font-semibold text-navy" title={server}>{server}</dd>
            </div>
            {data.account.last_login_at && (
              <div className="flex items-center justify-between gap-4 py-3">
                <dt className="text-sm text-muted">{t("Lần đăng nhập gần nhất")}</dt>
                <dd className="text-sm font-semibold tabular-nums text-navy">{formatDateTime(data.account.last_login_at)}</dd>
              </div>
            )}
          </dl>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <PrimaryButton variant="secondary" icon={KeyRound} onClick={() => setPasswordOpen(true)}>{t("Đổi mật khẩu")}</PrimaryButton>
            <PrimaryButton variant="secondary" icon={LogOut} loading={busy === "logout"}
              onClick={() => {
                setBusy("logout");
                void connection.logout().finally(() => setBusy(null));
              }}>{t("Đăng xuất")}</PrimaryButton>
          </div>
          <div className="mt-4">
            <Note>{t("Phiên đăng nhập được mã hóa bằng Windows (DPAPI) trên máy này. Cơ sở dữ liệu PostgreSQL chỉ nằm trên Mini PC; ứng dụng không chứa mật khẩu cơ sở dữ liệu.")}</Note>
          </div>
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
      <PasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
}
