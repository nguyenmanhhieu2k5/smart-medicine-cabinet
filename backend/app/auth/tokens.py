"""JWT access token (ngắn hạn) và refresh token ngẫu nhiên (chỉ lưu băm SHA-256)."""
from __future__ import annotations

import hashlib
import secrets
import time
import uuid
from dataclasses import dataclass

import jwt

ISSUER = "smart-medicine-cabinet"
ALGORITHM = "HS256"
AUDIENCES = ("scanner", "admin")


class TokenError(Exception):
    pass


@dataclass(frozen=True)
class AccessClaims:
    user_id: uuid.UUID
    session_id: uuid.UUID
    audience: str
    role: str
    expires_at: int


def create_access_token(secret: str, *, user_id: uuid.UUID, session_id: uuid.UUID, audience: str, role: str, minutes: int) -> tuple[str, int]:
    if audience not in AUDIENCES:
        raise ValueError(f"audience không hợp lệ: {audience}")
    now = int(time.time())
    exp = now + minutes * 60
    payload = {
        "iss": ISSUER, "sub": str(user_id), "sid": str(session_id), "aud": audience, "role": role,
        "iat": now, "nbf": now - 5, "exp": exp, "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, secret, algorithm=ALGORITHM), exp


def decode_access_token(secret: str, token: str, audience: str) -> AccessClaims:
    """Giải mã + kiểm tra chữ ký, hạn, issuer và **audience đúng kênh**."""
    try:
        data = jwt.decode(
            token, secret, algorithms=[ALGORITHM], audience=audience, issuer=ISSUER,
            options={"require": ["exp", "iat", "sub", "sid", "aud", "iss"]}, leeway=10,
        )
        return AccessClaims(
            user_id=uuid.UUID(data["sub"]), session_id=uuid.UUID(data["sid"]), audience=data["aud"],
            role=str(data.get("role", "")), expires_at=int(data["exp"]),
        )
    except jwt.ExpiredSignatureError as exc:
        raise TokenError("Phiên đăng nhập đã hết hạn.") from exc
    except jwt.InvalidAudienceError as exc:
        raise TokenError("Mã truy cập không dùng được cho kênh này.") from exc
    except (jwt.InvalidTokenError, ValueError, KeyError) as exc:
        raise TokenError("Mã truy cập không hợp lệ.") from exc


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def new_device_token() -> str:
    """Token thiết bị ESP32 (hiển thị một lần khi tạo thiết bị)."""
    return "smcdev_" + secrets.token_urlsafe(32)


def new_numeric_code(digits: int = 6) -> str:
    return "".join(secrets.choice("0123456789") for _ in range(digits))
