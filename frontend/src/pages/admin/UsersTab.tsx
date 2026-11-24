import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, Plus, Save, ShieldCheck, Smartphone, Trash2, UserRound, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { PrimaryButton } from "@/components/Button";
import { Card } from "@/components/Card";
import { DataTable, Pagination, type Column } from "@/components/DataTable";
import { Field, SearchInput, Segmented, Select, TextInput, Toggle } from "@/components/Form";
import { Note } from "@/components/MedicineBits";
import { ConfirmDialog, Modal } from "@/components/Modal";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { StatusIndicator } from "@/components/StatusIndicator";
import { useT } from "@/i18n";
import { api, currentUser } from "@/services/api";
import { formatDateTime } from "@/services/format";
import { errorMessage, useUserDetail, useUsers } from "@/services/queries";
import { toast } from "@/stores/toast";
import type { AdminUser, RoleCode } from "@/types/api";

const PAGE_SIZE = 20;
const ROLE_LABELS: Record<string, string> = { ADMIN: "Quản trị viên", SCANNER: "Người quét" };

function RoleChip({ role }: { role: string }) {
  const t = useT();
  return role === "ADMIN"
    ? <StatusIndicator tone="info" size="sm" icon={ShieldCheck}>{t("Quản trị viên")}</StatusIndicator>
    : <StatusIndicator tone="neutral" size="sm" icon={Smartphone}>{t("Người quét")}</StatusIndicator>;
}

function StateChip({ user }: { user: AdminUser }) {
  const t = useT();
  if (!user.is_active) return <StatusIndicator tone="neutral" size="sm" dot>{t("Vô hiệu")}</StatusIndicator>;
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) return <StatusIndicator tone="warning" size="sm" dot>{t("Tạm khóa")}</StatusIndicator>;
  return <StatusIndicator tone="success" size="sm" dot>{t("Hoạt động")}</StatusIndicator>;
}

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const empty = { email: "", full_name: "", phone: "", role: "SCANNER" as RoleCode, password: "", confirm: "" };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm(empty);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ đặt lại khi mở hộp thoại
  }, [open]);
  const mismatch = form.confirm !== "" && form.password !== form.confirm;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.userCreate({ email: form.email.trim(), full_name: form.full_name.trim(), phone: form.phone.trim() || null, role: form.role, password: form.password });
      toast.success(t("Đã tạo tài khoản"), form.email.trim());
      await client.invalidateQueries({ queryKey: ["users"] });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t("Thêm tài khoản")} size="md"
      footer={
        <>
          <PrimaryButton variant="secondary" onClick={onClose}>{t("Hủy")}</PrimaryButton>
          <PrimaryButton icon={Plus} loading={busy} disabled={!form.email.trim() || !form.password || form.password !== form.confirm} onClick={() => void submit()}>{t("Tạo tài khoản")}</PrimaryButton>
        </>
      }>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Email" required className="col-span-2"><TextInput type="email" value={form.email} maxLength={254} autoComplete="off" onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
        <Field label={t("Họ và tên")}><TextInput value={form.full_name} maxLength={120} onChange={(event) => setForm({ ...form, full_name: event.target.value })} /></Field>
        <Field label={t("Số điện thoại")}><TextInput type="tel" value={form.phone} maxLength={32} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></Field>
        <Field label={t("Vai trò")} className="col-span-2"
          hint={form.role === "ADMIN" ? t("Toàn quyền qua ứng dụng Windows (kênh Tailscale).") : t("Chỉ quét thuốc và xem lịch sử của mình trên ứng dụng điện thoại.")}>
          <Select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as RoleCode })} aria-label={t("Vai trò")}>
            <option value="SCANNER">{t("Người quét")} (SCANNER)</option>
            <option value="ADMIN">{t("Quản trị viên")} (ADMIN)</option>
          </Select>
        </Field>
        <Field label={t("Mật khẩu")} required hint={t("Ít nhất 8 ký tự, gồm cả chữ và số.")}><TextInput type="password" value={form.password} maxLength={200} autoComplete="new-password" onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
        <Field label={t("Nhập lại mật khẩu")} required error={mismatch ? t("Mật khẩu nhập lại không khớp.") : null}><TextInput type="password" value={form.confirm} maxLength={200} autoComplete="new-password" onChange={(event) => setForm({ ...form, confirm: event.target.value })} /></Field>
      </div>
      {error && <p role="alert" className="mt-4 rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">{error}</p>}
    </Modal>
  );
}

function UserDialog({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const t = useT();
  const client = useQueryClient();
  const detail = useUserDetail(userId);
  const user = detail.data?.user;
  const me = currentUser();
  const isSelf = Boolean(user && me && user.id === me.id);
  const [form, setForm] = useState({ full_name: "", phone: "", role: "SCANNER" as RoleCode, is_active: true });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (user) setForm({ full_name: user.full_name, phone: user.phone ?? "", role: (user.role as RoleCode) ?? "SCANNER", is_active: user.is_active });
    setPassword("");
  }, [user]);

  const run = async (label: string, action: () => Promise<unknown>, success: string, close = false) => {
    setBusy(label);
    try {
      await action();
      toast.success(success);
      await client.invalidateQueries({ queryKey: ["users"] });
      if (close) onClose();
    } catch (error) {
      toast.error(t("Không thực hiện được"), errorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  const dirty = user !== undefined && (form.full_name !== user.full_name || form.phone !== (user.phone ?? "") || form.role !== user.role || form.is_active !== user.is_active);

  return (
    <Modal open={userId !== null} onClose={onClose} size="lg" title={user?.full_name || user?.email || t("Tài khoản")} description={user?.email}
      footer={user && (
        <>
          <PrimaryButton variant="danger" icon={Trash2} disabled={isSelf} onClick={() => setConfirmDelete(true)}>{t("Xóa tài khoản")}</PrimaryButton>
          <span className="flex-1" />
          <PrimaryButton variant="secondary" onClick={onClose}>{t("Đóng")}</PrimaryButton>
          <PrimaryButton icon={Save} loading={busy === "save"} disabled={!dirty}
            onClick={() => void run("save", () => api.userUpdate(user.id, { full_name: form.full_name.trim(), phone: form.phone.trim() || null, role: form.role, is_active: form.is_active }), t("Đã lưu tài khoản"))}>
            {t("Lưu")}
          </PrimaryButton>
        </>
      )}>
      {detail.isLoading || !user ? <LoadingState rows={4} /> : (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
          <div className="space-y-4">
            <Field label={t("Họ và tên")}><TextInput value={form.full_name} maxLength={120} onChange={(event) => setForm({ ...form, full_name: event.target.value })} /></Field>
            <Field label={t("Số điện thoại")}><TextInput type="tel" value={form.phone} maxLength={32} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></Field>
            <Field label={t("Vai trò")} hint={isSelf ? t("Không thể tự hạ quyền tài khoản đang đăng nhập.") : undefined}>
              <Select value={form.role} disabled={isSelf} onChange={(event) => setForm({ ...form, role: event.target.value as RoleCode })} aria-label={t("Vai trò")}>
                <option value="SCANNER">{t("Người quét")} (SCANNER)</option>
                <option value="ADMIN">{t("Quản trị viên")} (ADMIN)</option>
              </Select>
            </Field>
            <div className="flex items-center justify-between rounded-2xl bg-tile px-4 py-3">
              <span className="text-sm text-navy">{t("Cho phép đăng nhập")}</span>
              <Toggle checked={form.is_active} disabled={isSelf} onChange={(v) => setForm({ ...form, is_active: v })} label={t("Cho phép đăng nhập")} />
            </div>
            <Note>{t("Hạ quyền hoặc vô hiệu hóa sẽ đăng xuất ngay mọi phiên của tài khoản. Quyền luôn được kiểm tra ở máy chủ.")}</Note>
          </div>
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-[13px] font-semibold text-navy">{t("Phiên đang mở")} · {detail.data?.sessions.length ?? 0}</p>
              {detail.data && detail.data.sessions.length > 0 ? (
                <ul className="max-h-[180px] divide-y divide-line overflow-y-auto rounded-2xl bg-tile px-4">
                  {detail.data.sessions.map((s) => (
                    <li key={s.id} className="py-2.5 text-[12.5px]">
                      <p className="font-semibold text-navy">{s.audience === "admin" ? t("Ứng dụng Windows (Admin)") : t("Ứng dụng điện thoại")}{s.client ? ` · ${s.client}` : ""}</p>
                      <p className="text-muted">{s.ip ?? "—"} · {t("dùng lần cuối")} {formatDateTime(s.last_used_at)}</p>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-[13px] text-muted">{t("Không có phiên nào.")}</p>}
              <PrimaryButton variant="secondary" size="sm" icon={LogOut} className="mt-2" loading={busy === "revoke"}
                onClick={() => void run("revoke", () => api.userRevokeSessions(user.id), t("Đã đăng xuất mọi phiên"))}>
                {isSelf ? t("Đăng xuất các phiên khác") : t("Đăng xuất mọi phiên")}
              </PrimaryButton>
            </div>
            <div className="border-t border-line pt-4">
              <Field label={t("Đặt mật khẩu mới")} hint={t("Người dùng sẽ bị đăng xuất khỏi mọi thiết bị.")}>
                <div className="flex gap-2">
                  <TextInput type="password" value={password} maxLength={200} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
                  <PrimaryButton variant="secondary" icon={KeyRound} loading={busy === "password"} disabled={password.length < 8}
                    onClick={() => void run("password", () => api.userSetPassword(user.id, password).then(() => setPassword("")), t("Đã đặt mật khẩu mới"))}>{t("Đặt")}</PrimaryButton>
                </div>
              </Field>
            </div>
            <dl className="divide-y divide-line text-[12.5px]">
              <div className="flex justify-between py-2"><dt className="text-muted">{t("Tạo lúc")}</dt><dd className="text-navy">{user.created_at ? formatDateTime(user.created_at) : "—"}</dd></div>
              <div className="flex justify-between py-2"><dt className="text-muted">{t("Đăng nhập gần nhất")}</dt><dd className="text-navy">{user.last_login_at ? formatDateTime(user.last_login_at) : "—"}</dd></div>
            </dl>
          </div>
        </div>
      )}
      <ConfirmDialog open={confirmDelete} danger title={t("Xóa tài khoản?")} confirmLabel={t("Xóa")} loading={busy === "delete"}
        description={t("Tài khoản “{email}” và các phiên đăng nhập của nó sẽ bị xóa. Lịch sử quét của tài khoản cũng bị xóa theo.", { email: user?.email ?? "" })}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => user && void run("delete", () => api.userDelete(user.id), t("Đã xóa tài khoản"), true).then(() => setConfirmDelete(false))} />
    </Modal>
  );
}

export function UsersTab() {
  const t = useT();
  const [q, setQ] = useState("");
  const [role, setRole] = useState<"all" | RoleCode>("all");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => setPage(1), [q, role]);
  const users = useUsers({ q: q.trim() || undefined, role: role === "all" ? undefined : role, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const data = users.data;
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  const columns: Column<AdminUser>[] = [
    {
      key: "user", header: t("Tài khoản"), width: "minmax(0,2.2fr)", render: (u) => (
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary"><UserRound size={18} /></span>
          <div className="min-w-0">
            <p className={u.full_name ? "truncate font-semibold text-navy" : "truncate italic text-muted"}>{u.full_name || t("Chưa đặt tên")}</p>
            <p className="truncate text-[12.5px] text-muted">{u.email}</p>
          </div>
        </div>
      ),
    },
    { key: "role", header: t("Vai trò"), width: "170px", render: (u) => <RoleChip role={u.role} /> },
    { key: "state", header: t("Trạng thái"), width: "130px", render: (u) => <StateChip user={u} /> },
    { key: "sessions", header: t("Phiên"), width: "80px", align: "center", render: (u) => <span className="tabular-nums text-navy">{u.active_sessions ?? 0}</span> },
    { key: "login", header: t("Đăng nhập gần nhất"), width: "170px", render: (u) => <span className="text-[13px] text-muted">{u.last_login_at ? formatDateTime(u.last_login_at) : "—"}</span> },
  ];

  return (
    <Card padding="none" className="pb-4">
      <div className="flex flex-wrap items-center gap-3 px-6 pb-4 pt-6">
        <SearchInput value={q} onChange={setQ} placeholder={t("Tìm theo email hoặc tên")} className="w-[340px] max-w-full" />
        <Segmented size="sm" value={role} onChange={setRole}
          options={[{ value: "all", label: t("Tất cả") }, { value: "ADMIN", label: t(ROLE_LABELS.ADMIN) }, { value: "SCANNER", label: t(ROLE_LABELS.SCANNER) }]} />
        <span className="flex-1" />
        <PrimaryButton icon={Plus} onClick={() => setCreating(true)}>{t("Thêm tài khoản")}</PrimaryButton>
      </div>
      {users.isError ? <ErrorState description={errorMessage(users.error)} onRetry={() => void users.refetch()} /> : (
        <DataTable columns={columns} rows={data?.items ?? []} rowKey={(u) => u.id} loading={users.isLoading} onRowClick={(u) => setOpenId(u.id)}
          empty={<EmptyState icon={Users} title={t("Không có tài khoản phù hợp")} compact />}
          footer={data && <Pagination page={page} pages={pages} total={data.total} onChange={setPage} label={t("{total} tài khoản", { total: data.total })} />} />
      )}
      <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
      <UserDialog userId={openId} onClose={() => setOpenId(null)} />
    </Card>
  );
}
