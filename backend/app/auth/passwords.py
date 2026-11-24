"""Băm và kiểm tra mật khẩu (Argon2id), kiểm tra độ mạnh tối thiểu."""
from __future__ import annotations

import re

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

MIN_LENGTH = 8
MAX_LENGTH = 128
# Tham số mặc định của argon2-cffi (RFC 9106, cấu hình thấp: 64 MiB, 3 vòng) — đủ nhanh trên Mini PC.
_hasher = PasswordHasher()
_DUMMY_HASH = _hasher.hash("smc-dummy-password-for-timing")


class WeakPasswordError(ValueError):
    pass


def check_strength(password: str) -> None:
    """Ném WeakPasswordError (thông báo tiếng Việt) nếu mật khẩu quá yếu."""
    if len(password) < MIN_LENGTH:
        raise WeakPasswordError(f"Mật khẩu cần tối thiểu {MIN_LENGTH} ký tự.")
    if len(password) > MAX_LENGTH:
        raise WeakPasswordError(f"Mật khẩu tối đa {MAX_LENGTH} ký tự.")
    if not re.search(r"[A-Za-zÀ-ỹ]", password) or not re.search(r"\d", password):
        raise WeakPasswordError("Mật khẩu cần có cả chữ và số.")
    if len(set(password)) < 4:
        raise WeakPasswordError("Mật khẩu quá đơn giản.")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """So khớp mật khẩu. Khi không có tài khoản vẫn tốn cùng thời gian (chống dò email)."""
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True
