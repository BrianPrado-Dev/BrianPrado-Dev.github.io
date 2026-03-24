"""
Servidor + impresor automático (todo en uno) para Windows.

Funciones:
- API local para recibir tickets/comandas desde la web:
  - POST   /api/impresiones
  - GET    /api/impresiones
  - DELETE /api/impresiones
- Worker de impresión cada 3 segundos.
- Imprime solo tickets con menos de 10 segundos de creados.
- Evita duplicados.

Uso:
1) pip install flask
2) python impresiones_poller.py
3) (Opcional) convertir a .exe con pyinstaller.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request

HOST = "0.0.0.0"
PORT = 8000
POLL_SECONDS = 3
MAX_AGE_SECONDS = 10

BASE_DIR = Path(__file__).resolve().parent
QUEUE_FILE = BASE_DIR / "impresiones_queue_runtime.json"
STATE_FILE = BASE_DIR / "impresiones_estado.json"

app = Flask(__name__)
LOCK = threading.Lock()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(dt_raw: str) -> datetime | None:
    if not dt_raw:
        return None
    try:
        return datetime.fromisoformat(dt_raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_queue() -> list[dict[str, Any]]:
    if not QUEUE_FILE.exists():
        return []
    try:
        payload = json.loads(QUEUE_FILE.read_text(encoding="utf-8"))
        queue = payload.get("queue", [])
        return queue if isinstance(queue, list) else []
    except Exception:
        return []


def save_queue(queue: list[dict[str, Any]]) -> None:
    QUEUE_FILE.write_text(
        json.dumps({"queue": queue}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_printed_ids() -> set[str]:
    if not STATE_FILE.exists():
        return set()
    try:
        payload = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        ids = payload.get("printed_ids", [])
        if isinstance(ids, list):
            return {str(x) for x in ids}
    except Exception:
        pass
    return set()


def save_printed_ids(printed_ids: set[str]) -> None:
    STATE_FILE.write_text(
        json.dumps({"printed_ids": sorted(printed_ids)}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def build_ticket_text(ticket: dict[str, Any]) -> str:
    ticket_type = str(ticket.get("type", "ticket")).strip().lower()
    table_number = ticket.get("tableNumber", "-")
    mesera = ticket.get("mesera", "Sin nombre")
    created_at = ticket.get("createdAt", "")
    total = ticket.get("total", 0)
    plates = ticket.get("plates", [])

    lines: list[str] = []
    lines.append("Tortas Ahogadas Doña Susy")
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


def should_print(ticket: dict[str, Any], printed_ids: set[str]) -> bool:
    ticket_id = str(ticket.get("id", "")).strip()
    if not ticket_id or ticket_id in printed_ids:
        return False

    created = parse_iso(str(ticket.get("createdAt", "")))
    if created is None:
        return False

    age = (now_utc() - created).total_seconds()
    return 0 <= age <= MAX_AGE_SECONDS


def printer_worker() -> None:
    printed_ids = load_printed_ids()
    while True:
        try:
            with LOCK:
                queue = load_queue()

            changed = False
            for ticket in queue:
                if not isinstance(ticket, dict):
                    continue
                if not should_print(ticket, printed_ids):
                    continue

                ticket_id = str(ticket.get("id"))
                print_text_windows(build_ticket_text(ticket))
                printed_ids.add(ticket_id)
                changed = True
                print(f"[PRINT] Ticket impreso: {ticket_id}")

            if changed:
                save_printed_ids(printed_ids)

        except Exception as err:
            print(f"[WARN] Error en worker: {err}")

        time.sleep(POLL_SECONDS)


@app.get("/api/impresiones")
def api_get_impresiones():
    with LOCK:
        queue = load_queue()
    return jsonify({"queue": queue})


@app.post("/api/impresiones")
def api_post_impresiones():
    ticket = request.get_json(silent=True)
    if not isinstance(ticket, dict):
        return jsonify({"ok": False, "error": "JSON inválido"}), 400
    if not str(ticket.get("id", "")).strip():
        return jsonify({"ok": False, "error": "Falta id"}), 400

    with LOCK:
        queue = load_queue()
        queue.insert(0, ticket)
        save_queue(queue)

    return jsonify({"ok": True})


@app.delete("/api/impresiones")
def api_delete_impresiones():
    with LOCK:
        save_queue([])
    return jsonify({"ok": True})


def main() -> None:
    worker = threading.Thread(target=printer_worker, daemon=True)
    worker.start()
    print(f"Servidor de impresión activo en http://{HOST}:{PORT}/api/impresiones")
    app.run(host=HOST, port=PORT, debug=False)


if __name__ == "__main__":
    main()
