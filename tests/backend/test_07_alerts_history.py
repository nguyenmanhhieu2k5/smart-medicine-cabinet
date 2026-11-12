"""13. Lưu lịch sử và cảnh báo (thuốc, hệ thống) + lời nhắc."""
from __future__ import annotations

from datetime import datetime, timedelta

from app.core import clock

from .conftest import AUGMENTIN_625, FROZEN_NOW

TODAY = FROZEN_NOW.date()


def add(client, **overrides) -> dict:
    body = {"name": "Thuốc A", "quantity": 20, "unit": "viên"} | overrides
    response = client.post("/api/cabinet/medicines", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def alerts(client, **params) -> dict:
    return client.get("/api/alerts", params=params).json()


# ---- Cảnh báo thuốc ------------------------------------------------------------ #
def test_no_alerts_at_start(client):
    body = alerts(client)
    assert body["items"] == [] and body["unhandled"] == 0 and body["open"] == 0
    assert client.get("/api/alerts/count").json() == {"unhandled": 0}


def test_medicine_alerts_expired_expiring_and_low_stock(client):
    add(client, name="Hết hạn", expiry_date=(TODAY - timedelta(days=2)).isoformat())
    add(client, name="Sắp hết hạn", expiry_date=(TODAY + timedelta(days=12)).isoformat())
    add(client, name="Sắp hết thuốc", quantity=3, expiry_date="2028-01-01")
    add(client, name="Bình thường", quantity=50, expiry_date="2028-01-01")
    body = alerts(client)
    found = {(a["type"], a["severity"], a["title"]) for a in body["items"]}
    assert found == {
        ("expired", "danger", "Hết hạn đã hết hạn"),
        ("expiring_soon", "warning", "Sắp hết hạn sắp hết hạn"),
        ("low_stock", "info", "Sắp hết thuốc sắp hết"),
    }
    assert body["items"][0]["severity"] == "danger"  # nguy hiểm xếp trước
    assert body["unhandled"] == 3 and body["by_category"] == {"environment": 0, "medicine": 3, "system": 0}
    assert len(alerts(client, severity="warning")["items"]) == 1
    assert alerts(client, category="environment")["items"] == []


def test_alert_lifecycle_seen_acknowledged_resolved(client):
    item = add(client, expiry_date=(TODAY - timedelta(days=1)).isoformat())
    alert = alerts(client)["items"][0]
    assert alert["status"] == "active"
    seen = client.patch(f"/api/alerts/{alert['id']}", json={"status": "seen"}).json()
    assert seen["status"] == "seen" and alerts(client)["unhandled"] == 1
    acked = client.patch(f"/api/alerts/{alert['id']}", json={"status": "acknowledged"}).json()
    assert acked["status"] == "acknowledged" and alerts(client)["unhandled"] == 0
    assert client.patch(f"/api/alerts/{alert['id']}", json={"status": "seen"}).json()["status"] == "acknowledged"  # không lùi trạng thái
    assert len(alerts(client)["items"]) == 1  # vẫn mở vì thuốc vẫn hết hạn

    client.patch(f"/api/cabinet/medicines/{item['id']}", json={"expiry_date": "2028-05-01"})
    assert alerts(client)["items"] == []
    resolved = alerts(client, scope="resolved")["items"]
    assert len(resolved) == 1 and resolved[0]["resolved_at"]
    assert client.patch("/api/alerts/99999", json={"status": "seen"}).status_code == 404


def test_alerts_follow_settings_and_deletion(client):
    item = add(client, quantity=8, expiry_date=(TODAY + timedelta(days=45)).isoformat())
    assert alerts(client)["items"] == []
    client.patch("/api/settings", json={"expiry_warning_days": 60, "low_stock_threshold": 10})
    assert {a["type"] for a in alerts(client)["items"]} == {"expiring_soon", "low_stock"}
    assert client.post("/api/alerts/mark-all", json={"status": "acknowledged"}).json() == {"updated": 2, "unhandled": 0}
    client.delete(f"/api/cabinet/medicines/{item['id']}")
    assert alerts(client)["items"] == []


def test_expiry_alert_appears_as_days_pass(client):
    add(client, expiry_date=(TODAY + timedelta(days=40)).isoformat())
    assert alerts(client)["items"] == []
    clock.set_now_fn(lambda: FROZEN_NOW + timedelta(days=15))
    assert [a["type"] for a in alerts(client)["items"]] == ["expiring_soon"]
    clock.set_now_fn(lambda: FROZEN_NOW + timedelta(days=41))
    assert [a["type"] for a in alerts(client)["items"]] == ["expired"]


def test_camera_error_reported_by_ui_and_resolved(client):
    assert client.post("/api/alerts/report", json={"type": "camera_error", "message": "Không tìm thấy camera"}).json() == {"unhandled": 1}
    client.post("/api/alerts/report", json={"type": "camera_error", "message": "Không tìm thấy camera"})
    system = alerts(client, category="system")["items"]
    assert len(system) == 1 and system[0]["title"] == "Camera không hoạt động"
    client.post("/api/alerts/report", json={"type": "camera_error", "resolved": True})
    assert alerts(client)["items"] == []
    assert client.post("/api/alerts/report", json={"type": "hack"}).status_code == 422


# ---- Lịch sử --------------------------------------------------------------------- #
def test_history_records_cabinet_changes_and_alerts(client):
    item = add(client, catalog_id=AUGMENTIN_625, name=None, expiry_date=(TODAY - timedelta(days=1)).isoformat())
    url = f"/api/cabinet/medicines/{item['id']}"
    client.post(url + "/adjust", json={"delta": -5})
    client.patch(url, json={"note": "ghi chú"})
    client.delete(url)
    events = client.get("/api/history").json()
    assert [e["type"] for e in events["items"]] == ["cabinet_delete", "cabinet_update", "quantity_change", "expired", "cabinet_add"]
    assert events["items"][2]["description"] == "Augmentin 625mg tablets: 20 → 15 viên"
    assert events["items"][3]["group"] == "alert" and events["items"][3]["group_label"] == "Cảnh báo"
    assert all(e["created_at"] == FROZEN_NOW.isoformat() for e in events["items"])


def test_history_filter_search_paginate_and_delete(client):
    for index in range(5):
        add(client, name=f"Thuốc {index}", quantity=30)
    client.post("/api/alerts/report", json={"type": "camera_error", "message": "x"})
    assert client.get("/api/history", params={"group": "cabinet"}).json()["total"] == 5
    assert client.get("/api/history", params={"group": "alert"}).json()["total"] == 1
    assert client.get("/api/history", params={"q": "Thuốc 3"}).json()["total"] == 1
    page = client.get("/api/history", params={"page": 2, "page_size": 4}).json()
    assert page["pages"] == 2 and len(page["items"]) == 2
    today = TODAY.isoformat()
    assert client.get("/api/history", params={"from": today, "to": today}).json()["total"] == 6
    tomorrow = (TODAY + timedelta(days=1)).isoformat()
    assert client.get("/api/history", params={"from": tomorrow}).json()["total"] == 0
    first = client.get("/api/history").json()["items"][0]
    assert client.get(f"/api/history/{first['id']}").json()["title"] == first["title"]
    assert client.delete(f"/api/history/{first['id']}").json() == {"deleted": 1}
    assert client.delete("/api/history").json()["deleted"] == 5
    assert client.get("/api/history").json()["total"] == 0


# ---- Lời nhắc ---------------------------------------------------------------------- #
def reminder(client, **overrides) -> dict:
    body = {"medicine_name": "Paracetamol 500 mg", "dose_text": "1 viên", "times": ["20:00", "08:00"], "start_date": TODAY.isoformat()} | overrides
    response = client.post("/api/reminders", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_reminder_crud_and_validation(client):
    created = reminder(client)
    assert created["times"] == ["08:00", "20:00"] and created["frequency_label"] == "Hằng ngày" and created["enabled"]
    weekly = reminder(client, frequency="weekly", days_of_week=[0, 2, 4], times=["07:30"])
    assert weekly["frequency_label"] == "Hằng tuần: T2, T4, T6"
    assert client.post("/api/reminders", json={"medicine_name": "x", "times": ["25:00"], "start_date": TODAY.isoformat()}).status_code == 422
    assert client.post("/api/reminders", json={"medicine_name": "x", "times": [], "start_date": TODAY.isoformat()}).status_code == 422
    assert client.post("/api/reminders", json={"times": ["08:00"], "start_date": TODAY.isoformat()}).status_code == 422
    assert client.post("/api/reminders", json={"medicine_name": "x", "times": ["08:00"], "frequency": "weekly", "start_date": TODAY.isoformat()}).status_code == 422
    off = client.patch(f"/api/reminders/{created['id']}", json={"enabled": False}).json()
    assert off["enabled"] is False
    assert client.delete(f"/api/reminders/{weekly['id']}").json()["deleted"] is True
    assert [r["id"] for r in client.get("/api/reminders").json()["items"]] == [created["id"]]
    types = [e["type"] for e in client.get("/api/history", params={"group": "reminder"}).json()["items"]]
    assert types == ["reminder_deleted", "reminder_toggled", "reminder_created", "reminder_created"]


def test_schedule_statuses_and_marking_taken_updates_stock(client):
    item = client.post("/api/cabinet/medicines", json={"name": "Paracetamol 500 mg", "quantity": 10}).json()
    created = reminder(client, cabinet_item_id=item["id"], medicine_name=None, dose_quantity=1, times=["08:00", "14:00", "20:00"])
    assert created["medicine_name"] == "Paracetamol 500 mg"
    today = TODAY.isoformat()
    rows = client.get("/api/reminders/schedule", params={"from": today, "to": today}).json()["items"]
    # Bây giờ là 14:32 → 08:00 đã lỡ (>2 giờ), 14:00 đến hạn, 20:00 sắp tới.
    assert [(r["time"], r["status"]) for r in rows] == [("08:00", "missed"), ("14:00", "due"), ("20:00", "upcoming")]

    url = f"/api/reminders/{created['id']}/log"
    taken = client.post(url, json={"scheduled_for": f"{today}T14:00:00", "status": "taken"}).json()
    assert taken["status"] == "taken"
    assert client.get(f"/api/cabinet/medicines/{item['id']}").json()["quantity"] == 9
    client.post(url, json={"scheduled_for": f"{today}T14:00:00", "status": "taken"})  # bấm lại không trừ lần hai
    assert client.get(f"/api/cabinet/medicines/{item['id']}").json()["quantity"] == 9
    client.post(url, json={"scheduled_for": f"{today}T14:00:00", "status": "pending"})  # hoàn tác → trả lại
    assert client.get(f"/api/cabinet/medicines/{item['id']}").json()["quantity"] == 10
    skipped = client.post(url, json={"scheduled_for": f"{today}T08:00:00", "status": "skipped"}).json()
    assert skipped["status"] == "skipped"
    assert client.post(url, json={"scheduled_for": f"{today}T09:13:00", "status": "taken"}).status_code == 400
    week = client.get("/api/reminders/schedule").json()
    assert week["from"] == "2026-11-09" and week["to"] == "2026-11-15" and len(week["items"]) == 3 * 6  # từ hôm nay (Thứ 3) đến CN


def test_due_reminders_are_notified_once(client):
    reminder(client, times=["14:30", "18:00"])
    first = client.post("/api/notifications/pending").json()
    assert [(i["kind"], i["time"]) for i in first["items"]] == [("reminder", "14:30")]
    assert first["items"][0]["body"] == "14:30 · Paracetamol 500 mg — 1 viên"
    assert client.post("/api/notifications/pending").json()["items"] == []
    clock.set_now_fn(lambda: datetime(2026, 11, 10, 18, 1))
    assert [i["time"] for i in client.post("/api/notifications/pending").json()["items"]] == ["18:00"]


def test_new_alerts_are_pushed_once_and_respect_settings(client):
    add(client, expiry_date=(TODAY - timedelta(days=1)).isoformat())
    items = client.post("/api/notifications/pending").json()["items"]
    assert [(i["kind"], i["severity"]) for i in items] == [("alert", "danger")]
    assert client.post("/api/notifications/pending").json()["items"] == []
    client.patch("/api/settings", json={"notify_reminders": False})
    reminder(client, times=["14:30"])
    assert client.post("/api/notifications/pending").json()["items"] == []
