"""Gửi email qua SMTP (mã đặt lại mật khẩu). Chỉ hoạt động khi đã cấu hình SMC_SMTP_*."""
from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage

from app.core.config import SmtpConfig


class SmtpMailer:
    def __init__(self, config: SmtpConfig):
        self.config = config

    def send(self, to: str, subject: str, body: str) -> None:
        c = self.config
        if not c.configured:
            raise RuntimeError("Chưa cấu hình SMTP.")
        msg = EmailMessage()
        msg["From"] = c.sender
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(body)
        context = ssl.create_default_context()
        if c.use_ssl:
            with smtplib.SMTP_SSL(c.host, c.port, context=context, timeout=20) as smtp:
                if c.username:
                    smtp.login(c.username, c.password or "")
                smtp.send_message(msg)
            return
        with smtplib.SMTP(c.host, c.port, timeout=20) as smtp:
            if c.starttls:
                smtp.starttls(context=context)
            if c.username:
                smtp.login(c.username, c.password or "")
            smtp.send_message(msg)

    def send_reset_code(self, to: str, code: str, minutes: int) -> None:
        self.send(
            to,
            "Mã đặt lại mật khẩu — Tủ thuốc thông minh",
            f"Mã xác minh của bạn là: {code}\n\n"
            f"Mã có hiệu lực trong {minutes} phút. Không chia sẻ mã này với người khác.\n"
            "Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.\n",
        )
