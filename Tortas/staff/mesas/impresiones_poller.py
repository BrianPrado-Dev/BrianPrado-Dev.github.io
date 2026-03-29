"""
Impresion automatica desde cola remota (Supabase) para Windows.

Requisitos:
- requests

Uso:
1) Configura SUPABASE_URL y SUPABASE_SERVICE_KEY.
2) Ejecuta: python impresiones_poller.py
"""

from __future__ import annotations

import os
import tempfile
import time
from datetime import datetime, timezone
from typing import Any

import requests

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://TU-PROYECTO.supabase.co")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "TU_SUPABASE_SERVICE_KEY")
SUPABASE_TABLE = "impresiones_queue"
POLL_SECONDS = 2
MAX_AGE_SECONDS = 120


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(dt_raw: str) -> datetime | None:
    if not dt_raw:
        return None
    try:
        return datetime.fromisoformat(dt_raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def headers() -> dict[str, str]:
    return {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    }


def configured() -> bool:
    return (
        SUPABASE_URL.endswith(".supabase.co")
        and "TU-PROYECTO" not in SUPABASE_URL
        and bool(SUPABASE_SERVICE_KEY)
        and "TU_SUPABASE_SERVICE_KEY" not in SUPABASE_SERVICE_KEY
    )


def build_ticket_text(ticket: dict[str, Any]) -> str:
    ticket_type = str(ticket.get("type", "ticket")).strip().lower()
    table_number = ticket.get("tableNumber", "-")
    mesera = ticket.get("mesera", "Sin nombre")
    created_at = ticket.get("createdAt", "")
    total = ticket.get("total", 0)
    plates = ticket.get("plates", [])

    lines: list[str] = []
    lines.append("Tortas Ahogadas Dona Susy")
    lines.append("================================")
    lines.append("COMANDA COCINA" if ticket_type == "comanda" else "TICKET CLIENTE")
    lines.append(f"Mesa: {table_number}")
    lines.append(f"Fecha: {created_at}")
    lines.append("")

    for plate in plates:
        lines.append(f"[{plate.get('name', 'Cliente')}]")
        items = plate.get("items", [])
        if not items:
            lines.append("  - Sin productos")
        for item in items:
            qty = item.get("qty", 0)
            name = item.get("name", "Item")
            variant = item.get("variant") or ""
            subtotal = item.get("subtotal", 0)
            variant_text = f" ({variant})" if variant else ""
            if ticket_type == "comanda":
                lines.append(f"  - {qty}x {name}{variant_text}")
            else:
                lines.append(f"  - {qty}x {name}{variant_text}   ${subtotal}")
        lines.append("")

    lines.append("--------------------------------")
    if ticket_type != "comanda":
        lines.append(f"TOTAL: ${total}")
        lines.append("Gracias por su preferencia")
    lines.append(f"Mesera: {mesera}")
    lines.append("")
    return "\n".join(lines)


def print_text_windows(text: str) -> None:
    with tempfile.NamedTemporaryFile(delete=False, suffix=".txt", mode="w", encoding="utf-8") as tmp:
        tmp.write(text)
        tmp_path = tmp.name
    try:
        os.startfile(tmp_path, "print")
    finally:
        time.sleep(2)
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def fetch_pending_rows() -> list[dict[str, Any]]:
    params = {
        "printed": "eq.false",
        "order": "created_at.asc",
        "limit": "50",
    }
    url = f"{SUPABASE_URL}/rest/v1/{SUPABASE_TABLE}"
    response = requests.get(url, headers=headers(), params=params, timeout=15)
    response.raise_for_status()
    rows = response.json()
    return rows if isinstance(rows, list) else []


def mark_row_printed(row_id: str) -> None:
    url = f"{SUPABASE_URL}/rest/v1/{SUPABASE_TABLE}?id=eq.{row_id}"
    response = requests.patch(url, headers=headers(), json={"printed": True}, timeout=15)
    response.raise_for_status()


def should_print(ticket: dict[str, Any]) -> bool:
    created = parse_iso(str(ticket.get("createdAt", "")))
    if created is None:
        return False
    age = (now_utc() - created).total_seconds()
    return 0 <= age <= MAX_AGE_SECONDS


def main() -> None:
    if not configured():
        print("[ERROR] Configura SUPABASE_URL y SUPABASE_SERVICE_KEY antes de ejecutar.")
        return

    print("[OK] Worker de impresion conectado a Supabase.")
    while True:
        try:
            rows = fetch_pending_rows()
            for row in rows:
                row_id = str(row.get("id", "")).strip()
                payload = row.get("payload")
                if not row_id or not isinstance(payload, dict):
                    continue
                if not should_print(payload):
                    mark_row_printed(row_id)
                    continue
                print_text_windows(build_ticket_text(payload))
                mark_row_printed(row_id)
                print(f"[PRINT] Ticket impreso: {row_id}")
        except Exception as err:
            print(f"[WARN] Error en worker: {err}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()

