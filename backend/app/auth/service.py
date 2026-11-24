"""Nghiệp vụ tài khoản: đăng ký, đăng nhập theo kênh, phiên, đổi/đặt lại mật khẩu, kiểm toán."""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from email_validator import EmailNotValidError, validate_email
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.auth import passwords, tokens
from app.auth.ratelimit import RateLimiter
from app.core import clock
from app.core.config import Settings
from app.database.session import Database, iso_local
from app.models import ROLE_ADMIN, ROLE_SCANNER, AuditLog, PasswordReset, Role, User, UserSession

log = logging.getLogger("smc.auth")

CHANNEL_AUDIENCE = {"admin": "admin", "public": "scanner"}
RESET_CODE_MINUTES = 15
RESET_MAX_ATTEMPTS = 5


class AuthError(Exception):
    def __init__(self, message: str, status_code: int = 400, code: str = "auth_error"):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    email: str
    full_name: str
    role: str
    permissions: frozenset[str]
    session_id: uuid.UUID
    channel: str  # admin | public

    def has(self, permission: str) -> bool:
        return permission in self.permissions

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_ADMIN


@dataclass
class RequestMeta:
    ip: str | None = None
    user_agent: str | None = None
    client: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def normalize_email(email: str) -> str:
    try:
        result = validate_email(email.strip(), check_deliverability=False)
    except EmailNotValidError as exc:
        raise AuthError("Email không hợp lệ.", 422, "invalid_email") from exc
    return result.normalized.lower()


def user_public(user: User) -> dict[str, Any]:
    return {
        "id": str(user.id),
        "email": user.email,
        "full_name": user.full_name,
        "phone": user.phone,
        "role": user.role_code,
        "role_name": user.role.name if user.role else None,
        "permissions": sorted(user.permission_codes),
        "is_active": user.is_active,
        "created_at": iso_local(user.created_at),
        "last_login_at": iso_local(user.last_login_at),
        "locked_until": iso_local(user.locked_until),
    }


def audit(
    s: Session, action: str, *, channel: str, user_id: uuid.UUID | None = None, actor: str | None = None,
    resource_type: str | None = None, resource_id: str | None = None, success: bool = True,
    ip: str | None = None, detail: dict[str, Any] | None = None,
) -> None:
    s.add(AuditLog(
        created_at=clock.now(), user_id=user_id, actor=actor, channel=channel, action=action,
        resource_type=resource_type, resource_id=resource_id, success=success, ip=ip, detail=detail,
    ))


class AuthService:
    def __init__(self, db: Database, settings: Settings, limiter: RateLimiter | None = None, mailer: Any = None):
        self.db = db
        self.settings = settings
        self.limiter = limiter or RateLimiter()
        self.mailer = mailer
        self._secret: str | None = None

    @property
    def secret(self) -> str:
        if self._secret is None:
            self._secret = self.settings.resolve_jwt_secret()
        return self._secret

    # ------------------------------------------------------------------ #
    @staticmethod
    def role(s: Session, code: str) -> Role:
        role = s.scalar(select(Role).where(Role.code == code))
        if role is None:  # pragma: no cover — có sẵn từ migration 0001
            raise AuthError(f"Thiếu vai trò {code} trong CSDL (chạy migration).", 500)
        return role

    @staticmethod
    def find_user(s: Session, email: str) -> User | None:
        return s.scalar(select(User).where(func.lower(User.email) == email.lower()))

    def count_admins(self, s: Session) -> int:
        return s.scalar(
            select(func.count()).select_from(User).join(Role).where(Role.code == ROLE_ADMIN, User.is_active.is_(True))
        ) or 0

    # ---- tạo tài khoản --------------------------------------------------- #
    def create_user(
        self, s: Session, *, email: str, password: str, full_name: str = "", role_code: str = ROLE_SCANNER,
        phone: str | None = None, is_active: bool = True,
    ) -> User:
        email_norm = normalize_email(email)
        try:
            passwords.check_strength(password)
        except passwords.WeakPasswordError as exc:
            raise AuthError(str(exc), 422, "weak_password") from exc
        if self.find_user(s, email_norm) is not None:
            raise AuthError("Email đã được sử dụng.", 409, "email_taken")
        now = clock.now()
        user = User(
            email=email_norm, full_name=(full_name or "").strip()[:120], phone=(phone or None),
            password_hash=passwords.hash_password(password), role=self.role(s, role_code),
            is_active=is_active, created_at=now, updated_at=now, password_changed_at=now, preferences={},
        )
        s.add(user)
        s.flush()
        return user

    def register(self, *, email: str, password: str, full_name: str, meta: RequestMeta) -> dict[str, Any]:
        """Đăng ký từ ứng dụng di động: luôn là SCANNER, cấp phiên kênh public."""
        if not self.settings.allow_registration:
            raise AuthError("Máy chủ đang tắt đăng ký tài khoản mới. Liên hệ quản trị viên.", 403, "registration_disabled")
        self.limiter.hit("register_ip", meta.ip)
        if not (full_name or "").strip():
            raise AuthError("Vui lòng nhập họ và tên.", 422, "name_required")
        with self.db.session() as s:
            user = self.create_user(s, email=email, password=password, full_name=full_name, role_code=ROLE_SCANNER)
            audit(s, "auth.register", channel="public", user_id=user.id, actor=user.email, resource_type="user",
                  resource_id=str(user.id), ip=meta.ip)
            return self._issue(s, user, "scanner", meta)

    # ---- đăng nhập / phiên ----------------------------------------------- #
    def login(self, *, email: str, password: str, channel: str, meta: RequestMeta) -> dict[str, Any]:
        audience = CHANNEL_AUDIENCE[channel]
        self.limiter.hit("login_ip", meta.ip)
        try:
            email_norm = normalize_email(email)
        except AuthError:
            raise AuthError("Email hoặc mật khẩu không đúng.", 401, "invalid_credentials") from None
        self.limiter.hit("login_email", email_norm)
        now = clock.now()
        with self.db.session() as s:
            user = self.find_user(s, email_norm)
            if user is not None and user.locked_until and user.locked_until > now:
                minutes = max(1, int((user.locked_until - now).total_seconds() // 60) + 1)
                audit(s, "auth.login", channel=channel, user_id=user.id, actor=email_norm, success=False, ip=meta.ip,
                      detail={"reason": "locked"})
                s.commit()
                raise AuthError(f"Tài khoản tạm khóa do đăng nhập sai nhiều lần. Thử lại sau {minutes} phút.", 423, "locked")
            ok = passwords.verify_password(user.password_hash if user else None, password)
            if not ok or user is None:
                if user is not None:
                    user.failed_logins += 1
                    if user.failed_logins >= self.settings.max_login_failures:
                        user.locked_until = now + timedelta(minutes=self.settings.lockout_minutes)
                        user.failed_logins = 0
                audit(s, "auth.login", channel=channel, user_id=user.id if user else None, actor=email_norm,
                      success=False, ip=meta.ip, detail={"reason": "bad_password" if user else "unknown_email"})
                s.commit()
                raise AuthError("Email hoặc mật khẩu không đúng.", 401, "invalid_credentials")
            if not user.is_active:
                audit(s, "auth.login", channel=channel, user_id=user.id, actor=email_norm, success=False, ip=meta.ip,
                      detail={"reason": "inactive"})
                s.commit()
                raise AuthError("Tài khoản đã bị vô hiệu hóa. Liên hệ quản trị viên.", 403, "inactive")
            if channel == "admin" and user.role_code != ROLE_ADMIN:
                audit(s, "auth.login", channel=channel, user_id=user.id, actor=email_norm, success=False, ip=meta.ip,
                      detail={"reason": "not_admin"})
                s.commit()
                raise AuthError("Tài khoản này không có quyền quản trị.", 403, "not_admin")
            user.failed_logins = 0
            user.locked_until = None
            user.last_login_at = now
            if passwords.needs_rehash(user.password_hash):
                user.password_hash = passwords.hash_password(password)
            audit(s, "auth.login", channel=channel, user_id=user.id, actor=email_norm, ip=meta.ip,
                  detail={"client": meta.client})
            self.limiter.reset("login_email", email_norm)
            return self._issue(s, user, audience, meta)

    def _issue(self, s: Session, user: User, audience: str, meta: RequestMeta) -> dict[str, Any]:
        now = clock.now()
        refresh = tokens.new_refresh_token()
        session = UserSession(
            user_id=user.id, refresh_hash=tokens.sha256_hex(refresh), audience=audience,
            client=(meta.client or None) and meta.client[:32], user_agent=(meta.user_agent or "")[:400] or None,
            ip=meta.ip, created_at=now, last_used_at=now, expires_at=now + timedelta(days=self.settings.refresh_token_days),
        )
        s.add(session)
        s.flush()
        return self._token_response(s, user, session, refresh)

    def _token_response(self, s: Session, user: User, session: UserSession, refresh: str) -> dict[str, Any]:
        access, exp = tokens.create_access_token(
            self.secret, user_id=user.id, session_id=session.id, audience=session.audience,
            role=user.role_code, minutes=self.settings.access_token_minutes,
        )
        return {
            "access_token": access,
            "token_type": "bearer",
            "expires_in": self.settings.access_token_minutes * 60,
            "expires_at": exp,
            "refresh_token": refresh,
            "refresh_expires_at": iso_local(session.expires_at),
            "session_id": str(session.id),
            "user": self._channel_user(s, user, session.audience),
        }

    def _channel_user(self, s: Session, user: User, audience: str) -> dict[str, Any]:
        """Thông tin tài khoản trả về theo kênh. Kênh công khai (mobile) luôn chỉ có vai trò + quyền SCANNER."""
        data = user_public(user)
        if audience == "scanner":
            data |= {"role": ROLE_SCANNER, "role_name": "Người quét (chỉ đọc)", "account_role": user.role_code,
                     "permissions": sorted(p.code for p in self.role(s, ROLE_SCANNER).permissions)}
        return data

    def refresh(self, *, refresh_token: str, channel: str, meta: RequestMeta) -> dict[str, Any]:
        audience = CHANNEL_AUDIENCE[channel]
        self.limiter.hit("refresh_ip", meta.ip)
        digest = tokens.sha256_hex(refresh_token or "")
        now = clock.now()
        with self.db.session() as s:
            session = s.scalar(select(UserSession).where(UserSession.refresh_hash == digest))
            if session is None or session.audience != audience:
                raise AuthError("Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.", 401, "invalid_refresh")
            if session.revoked_at is not None:
                if session.revoked_reason == "rotated":
                    # Token đã xoay vòng bị dùng lại → có thể bị lộ: thu hồi mọi phiên của tài khoản.
                    self._revoke_all(s, session.user_id, "reuse_detected")
                    audit(s, "auth.refresh_reuse", channel=channel, user_id=session.user_id, success=False, ip=meta.ip)
                    s.commit()
                raise AuthError("Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.", 401, "invalid_refresh")
            user = session.user
            if session.expires_at <= now or not user.is_active or (audience == "admin" and user.role_code != ROLE_ADMIN):
                session.revoked_at, session.revoked_reason = now, "expired"
                s.commit()
                raise AuthError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "invalid_refresh")
            session.revoked_at, session.revoked_reason = now, "rotated"
            refresh = tokens.new_refresh_token()
            new_session = UserSession(
                user_id=user.id, refresh_hash=tokens.sha256_hex(refresh), audience=audience, client=session.client,
                user_agent=(meta.user_agent or session.user_agent or "")[:400] or None, ip=meta.ip or session.ip,
                created_at=now, last_used_at=now, expires_at=session.expires_at,
            )
            if new_session.expires_at <= now:  # pragma: no cover
                raise AuthError("Phiên đăng nhập đã hết hạn.", 401, "invalid_refresh")
            s.add(new_session)
            s.flush()
            return self._token_response(s, user, new_session, refresh)

    def logout(self, *, refresh_token: str | None = None, session_id: uuid.UUID | None = None) -> None:
        now = clock.now()
        with self.db.session() as s:
            session = None
            if refresh_token:
                session = s.scalar(select(UserSession).where(UserSession.refresh_hash == tokens.sha256_hex(refresh_token)))
            elif session_id:
                session = s.get(UserSession, session_id)
            if session is not None and session.revoked_at is None:
                session.revoked_at, session.revoked_reason = now, "logout"

    @staticmethod
    def _revoke_all(s: Session, user_id: uuid.UUID, reason: str, keep: uuid.UUID | None = None) -> None:
        stmt = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        if keep is not None:
            stmt = stmt.where(UserSession.id != keep)
        s.execute(stmt.values(revoked_at=clock.now(), revoked_reason=reason))

    def authenticate(self, token: str, channel: str) -> Principal:
        """Access token → Principal. Kiểm tra cả trạng thái tài khoản và phiên trong CSDL."""
        claims = tokens.decode_access_token(self.secret, token, CHANNEL_AUDIENCE[channel])
        with self.db.session() as s:
            session = s.get(UserSession, claims.session_id)
            if session is None or session.revoked_at is not None or session.user_id != claims.user_id:
                raise tokens.TokenError("Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.")
            user = session.user
            if not user.is_active:
                raise tokens.TokenError("Tài khoản đã bị vô hiệu hóa.")
            if channel == "admin" and user.role_code != ROLE_ADMIN:
                raise tokens.TokenError("Tài khoản này không có quyền quản trị.")
            permissions = frozenset(user.permission_codes)
            if channel == "public":
                # Kênh công khai chỉ mang quyền của SCANNER, kể cả khi tài khoản là ADMIN.
                permissions = frozenset(p.code for p in self.role(s, ROLE_SCANNER).permissions)
            return Principal(
                user_id=user.id, email=user.email, full_name=user.full_name, role=user.role_code,
                permissions=permissions, session_id=session.id, channel=channel,
            )

    # ---- mật khẩu -------------------------------------------------------- #
    def change_password(self, principal: Principal, current: str, new: str, meta: RequestMeta) -> None:
        with self.db.session() as s:
            user = s.get(User, principal.user_id)
            if user is None or not passwords.verify_password(user.password_hash, current):
                audit(s, "auth.password_change", channel=principal.channel, user_id=principal.user_id, actor=principal.email,
                      success=False, ip=meta.ip)
                s.commit()
                raise AuthError("Mật khẩu hiện tại không đúng.", 400, "bad_password")
            try:
                passwords.check_strength(new)
            except passwords.WeakPasswordError as exc:
                raise AuthError(str(exc), 422, "weak_password") from exc
            user.password_hash = passwords.hash_password(new)
            user.password_changed_at = user.updated_at = clock.now()
            self._revoke_all(s, user.id, "password_changed", keep=principal.session_id)
            audit(s, "auth.password_change", channel=principal.channel, user_id=user.id, actor=user.email, ip=meta.ip)

    def admin_set_password(self, s: Session, user: User, new: str) -> None:
        try:
            passwords.check_strength(new)
        except passwords.WeakPasswordError as exc:
            raise AuthError(str(exc), 422, "weak_password") from exc
        user.password_hash = passwords.hash_password(new)
        user.password_changed_at = user.updated_at = clock.now()
        user.failed_logins, user.locked_until = 0, None
        self._revoke_all(s, user.id, "password_reset_by_admin")

    @property
    def password_reset_available(self) -> bool:
        return bool(self.mailer is not None and self.settings.smtp.configured)

    def request_password_reset(self, email: str, meta: RequestMeta) -> None:
        """Gửi mã 6 số qua email nếu tài khoản tồn tại. Luôn trả về như nhau (chống dò email)."""
        if not self.password_reset_available:
            raise AuthError("Máy chủ chưa cấu hình gửi email nên chưa đặt lại mật khẩu được. Liên hệ quản trị viên.", 503, "reset_unavailable")
        self.limiter.hit("forgot_ip", meta.ip)
        try:
            email_norm = normalize_email(email)
        except AuthError:
            return
        self.limiter.hit("forgot_email", email_norm)
        code = tokens.new_numeric_code()
        now = clock.now()
        with self.db.session() as s:
            user = self.find_user(s, email_norm)
            if user is None or not user.is_active:
                audit(s, "auth.password_reset_request", channel="public", actor=email_norm, success=False, ip=meta.ip)
                return
            s.execute(update(PasswordReset).where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None))
                      .values(used_at=now))
            s.add(PasswordReset(user_id=user.id, code_hash=tokens.sha256_hex(f"{user.id}:{code}"), created_at=now,
                                expires_at=now + timedelta(minutes=RESET_CODE_MINUTES)))
            audit(s, "auth.password_reset_request", channel="public", user_id=user.id, actor=email_norm, ip=meta.ip)
            to = user.email
        try:
            self.mailer.send_reset_code(to, code, RESET_CODE_MINUTES)
        except Exception:  # noqa: BLE001 — không tiết lộ lỗi SMTP cho người dùng ẩn danh
            log.exception("Không gửi được email đặt lại mật khẩu")

    def confirm_password_reset(self, *, email: str, code: str, new_password: str, meta: RequestMeta) -> None:
        self.limiter.hit("reset_ip", meta.ip)
        invalid = AuthError("Mã xác minh không đúng hoặc đã hết hạn.", 400, "invalid_code")
        try:
            email_norm = normalize_email(email)
        except AuthError:
            raise invalid from None
        try:
            passwords.check_strength(new_password)
        except passwords.WeakPasswordError as exc:
            raise AuthError(str(exc), 422, "weak_password") from exc
        now = clock.now()
        with self.db.session() as s:
            user = self.find_user(s, email_norm)
            if user is None:
                raise invalid
            reset = s.scalar(
                select(PasswordReset).where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None))
                .order_by(PasswordReset.created_at.desc()).limit(1)
            )
            if reset is None or reset.expires_at <= now or reset.attempts >= RESET_MAX_ATTEMPTS:
                raise invalid
            if reset.code_hash != tokens.sha256_hex(f"{user.id}:{(code or '').strip()}"):
                reset.attempts += 1
                s.commit()
                raise invalid
            reset.used_at = now
            user.password_hash = passwords.hash_password(new_password)
            user.password_changed_at = user.updated_at = now
            user.failed_logins, user.locked_until = 0, None
            self._revoke_all(s, user.id, "password_reset")
            audit(s, "auth.password_reset", channel="public", user_id=user.id, actor=user.email, ip=meta.ip)

    # ---- tiện ích -------------------------------------------------------- #
    @staticmethod
    def prune_sessions(s: Session, now: datetime | None = None) -> int:
        now = now or clock.now()
        result = s.execute(
            UserSession.__table__.delete().where(
                (UserSession.expires_at < now - timedelta(days=7))
                | (UserSession.revoked_at < now - timedelta(days=7))
            )
        )
        return result.rowcount or 0
