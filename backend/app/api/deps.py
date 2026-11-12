from __future__ import annotations

from fastapi import HTTPException, Request

from app.core.context import AppContext


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx


def not_found(what: str = "Không tìm thấy dữ liệu") -> HTTPException:
    return HTTPException(status_code=404, detail=what)


def bad_request(message: str) -> HTTPException:
    return HTTPException(status_code=400, detail=message)
