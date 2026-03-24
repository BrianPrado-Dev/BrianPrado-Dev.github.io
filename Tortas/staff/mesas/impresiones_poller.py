"""
Poller de impresión para Windows 10 (restaurante).

Qué hace:
- Consulta un endpoint cada 3 segundos.
- Busca tickets creados hace menos de 10 segundos.
- Imprime solo tickets no impresos antes.
- Soporta 2 tipos: ticket cliente y comanda cocina.

Uso:
1) Instalar dependencia: pip install requests
2) Editar API_URL con tu endpoint real.
3) Ejecutar: python impresiones_poller.py
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

# === Configuración ===
API_URL = "http://127.0.0.1:5500/Tortas/staff/mesas/index.html"  # Cambia por tu endpoint
POLL_SECONDS = 3
MAX_AGE_SECONDS = 10
REQUEST_TIMEOUT_SECONDS = 5
STATE_FILE = Path(__file__).with_name("impresiones_estado.json")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(dt_raw: str) -> datetime | None:
    if not dt_raw:
        return None
    try:
        return datetime.fromisoformat(dt_raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_state() -> set[str]:
    if not STATE_FILE.exists():
        return set()
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        done = data.get("printed_ids", [])
        if isinstance(done, list):
            return {str(x) for x in done}
    except Exception:
        pass
    return set()


def save_state(printed_ids: set[str]) -> None:
    payload = {"printed_ids": sorted(printed_ids)}
    STATE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_tickets() -> list[dict[str, Any]]:
    response = requests.get(API_URL, timeout=REQUEST_TIMEOUT_SECONDS)
    response.raise_for_status()
    data = response.json()

    # Soporta:
    # - {"queue": [...]}
    # - {"tickets": [...]}
    # - [...]
    if isinstance(data, dict):
        if isinstance(data.get("queue"), list):
            return data["queue"]
        if isinstance(data.get("tickets"), list):
            return data["tickets"]
        return []
    if isinstance(data, list):
        return data
    return []


def build_ticket_text(ticket: dict[str, Any]) -> str:
    ticket_type = str(ticket.get("type", "ticket")).strip().lower()
    table_number = ticket.get("tableNumber", "-")
    mesera = ticket.get("mesera", "Sin nombre")
    created_at = ticket.get("createdAt", "")
    total = ticket.get("total", 0)
    plates = ticket.get("plates", [])

    lines = []
    lines.append("Tortas Ahogadas Doña Susy")
    lines.append("================================")
    if ticket_type == "comanda":
        lines.append("COMANDA COCINA")
    else:
        lines.append("TICKET CLIENTE")
    lines.append(f"Mesa: {table_number}")
    lines.append(f"Fecha: {created_at}")
    lines.append("")

    for plate in plates:
        plate_name = plate.get("name", "Cliente")
        lines.append(f"[{plate_name}]")
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
        # Imprime con la impresora predeterminada en Windows.
        os.startfile(tmp_path, "print")
    finally:
        # Espera corta para que Windows tome el archivo.
        time.sleep(2)
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def should_print(ticket: dict[str, Any], printed_ids: set[str]) -> bool:
    ticket_id = str(ticket.get("id", "")).strip()
    if not ticket_id or ticket_id in printed_ids:
        return False

    created = parse_iso(str(ticket.get("createdAt", "")))
    if created is None:
        return False

    age = (now_utc() - created).total_seconds()
    return 0 <= age <= MAX_AGE_SECONDS


def main() -> None:
    printed_ids = load_state()
    print(f"Poller activo. Consultando cada {POLL_SECONDS}s -> {API_URL}")

    while True:
        try:
            tickets = fetch_tickets()
            for ticket in tickets:
                if not isinstance(ticket, dict):
                    continue
                if not should_print(ticket, printed_ids):
                    continue

                ticket_id = str(ticket.get("id"))
                text = build_ticket_text(ticket)
                print_text_windows(text)
                printed_ids.add(ticket_id)
                save_state(printed_ids)
                print(f"Impreso ticket: {ticket_id}")

        except requests.RequestException as err:
            print(f"[WARN] Error de red: {err}")
        except Exception as err:
            print(f"[WARN] Error inesperado: {err}")

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
