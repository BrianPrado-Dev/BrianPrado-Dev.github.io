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
import time
import textwrap
from datetime import datetime, timezone
from typing import Any

import requests
import win32print
import win32ui
from win32con import FW_NORMAL

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://TU-PROYECTO.supabase.co")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_TABLE = "impresiones_queue"
POLL_SECONDS = 2
MAX_AGE_SECONDS = 120
LINE_WIDTH = 25


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


def current_date_text() -> str:
    return datetime.now().strftime("%d/%m/%Y")


def wrap_line(text: str, width: int = LINE_WIDTH) -> list[str]:
    clean = str(text or "").strip()
    if not clean:
        return [""]
    return textwrap.wrap(clean, width=width, break_long_words=True, break_on_hyphens=False) or [clean[:width]]


def format_with_right(left: str, right: str, width: int = LINE_WIDTH) -> list[str]:
    right_text = str(right).strip()
    left_parts = wrap_line(left, width=max(1, width - max(0, len(right_text) + 1)))
    if not left_parts:
        left_parts = [""]
    first_left = left_parts[0]
    spaces = max(1, width - len(first_left) - len(right_text))
    lines = [f"{first_left}{' ' * spaces}{right_text}"[:width]]
    lines.extend(left_parts[1:])
    return lines


def drinks_summary_lines(ticket: dict[str, Any]) -> list[str]:
    """Resumen de bebidas del PDV (ya viene calculado en el payload)."""
    resumen = ticket.get("resumenBebidas")
    if not isinstance(resumen, dict):
        return []
    refrescos = resumen.get("refrescos")
    aguas = resumen.get("aguas")
    lines: list[str] = []
    if isinstance(refrescos, dict) and refrescos:
        lines.extend(wrap_line("RESUMEN DE REFRESCOS:"))
        for tipo, cant in refrescos.items():
            lines.extend(wrap_line(f"- {tipo}: {cant}"))
    if isinstance(aguas, dict) and aguas:
        lines.extend(wrap_line("RESUMEN DE AGUAS FRESCAS:"))
        for sabor, cant in aguas.items():
            lines.extend(wrap_line(f"- {sabor}: {cant}"))
    return lines


def build_pdv_ticket_text(ticket: dict[str, Any]) -> str:
    """Ticket del PDV (domicilio): mismo formato que el ticket de mesas,
    agregando datos del cliente, resumen de bebidas y numero de pedido."""
    lines: list[str] = []
    lines.append("Tortas Ahogadas Dona Susy")
    lines.append("Geranio #869")
    lines.append("+52 3336844525")
    lines.append("=" * LINE_WIDTH)
    lines.extend(wrap_line(f"Domicilio: {ticket.get('domicilio', '')}"))
    telefono = str(ticket.get("telefono") or "").strip()
    if telefono:
        lines.extend(wrap_line(f"Telefono: {telefono}"))
    lines.extend(wrap_line(f"Cruces: {ticket.get('cruces', '')}"))
    fecha = str(ticket.get("fechaHora") or "").strip() or current_date_text()
    lines.extend(wrap_line(f"Fecha: {fecha}"))
    hora = str(ticket.get("horaEspecifica") or "").strip()
    if hora:
        lines.extend(wrap_line(f"Hora especifica: {hora}"))
    lines.append("=" * LINE_WIDTH)
    lines.append("")

    items = ticket.get("items", [])
    if not isinstance(items, list):
        items = []
    groups: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        group = str(item.get("grupo") or "General")
        groups.setdefault(group, []).append(item)
    # General va al final; el resto en orden alfabetico (igual que el PDV web)
    group_names = sorted(groups.keys(), key=lambda name: (1 if name == "General" else 0, name))

    if not group_names:
        lines.extend(wrap_line("- Sin productos"))
    for group_idx, group in enumerate(group_names):
        if group_idx > 0:
            lines.append("=" * LINE_WIDTH)
        lines.extend(wrap_line(f"Cliente: {group.upper()}"))
        group_items = groups[group]
        for item_idx, item in enumerate(group_items):
            qty = item.get("cantidad", 1)
            name = item.get("nombre", "Item")
            precio = item.get("precio", 0)
            lines.extend(format_with_right(f"{qty}x {name}", f"${precio}"))
            nota = str(item.get("anotacion") or "").strip()
            if nota:
                lines.extend(wrap_line(f"({nota})"))
            if item_idx < len(group_items) - 1:
                lines.append("-" * LINE_WIDTH)
        lines.append("")

    lines.append("-" * LINE_WIDTH)
    lines.extend(format_with_right("TOTAL:", f"${ticket.get('total', 0)}"))

    drinks = drinks_summary_lines(ticket)
    if drinks:
        lines.append("=" * LINE_WIDTH)
        lines.extend(drinks)

    lines.append("=" * LINE_WIDTH)
    numero = str(ticket.get("numeroPedido") or "").strip()
    if numero:
        lines.extend(wrap_line(f"N. PEDIDO: {numero}"))
    lines.append("Gracias por su pedido")
    lines.extend(wrap_line(f"Mesera: {ticket.get('mesera', 'Sin nombre')}"))
    lines.append("")
    return "\n".join(lines)


def build_pdv_resumen_text(ticket: dict[str, Any]) -> str:
    """Resumen del dia del PDV: domicilios con total, bebidas y total general."""
    lines: list[str] = []
    lines.append("RESUMEN DEL DIA PDV")
    lines.append("=" * LINE_WIDTH)
    lines.extend(wrap_line(f"Fecha: {current_date_text()}"))
    lines.append("")

    pedidos = ticket.get("pedidos", [])
    if not isinstance(pedidos, list) or not pedidos:
        lines.append("Sin pedidos")
    else:
        for pedido in pedidos:
            if not isinstance(pedido, dict):
                continue
            domicilio = pedido.get("domicilio", "-")
            total = pedido.get("total", 0)
            lines.extend(format_with_right(str(domicilio), f"${total}"))
            lines.append("-" * LINE_WIDTH)

    drinks = drinks_summary_lines(ticket)
    if drinks:
        lines.extend(drinks)
        lines.append("-" * LINE_WIDTH)

    lines.append("=" * LINE_WIDTH)
    lines.extend(format_with_right("TOTAL GENERAL:", f"${ticket.get('totalGeneral', 0)}"))
    lines.extend(wrap_line(f"Mesera: {ticket.get('mesera', 'Sin nombre')}"))
    lines.append("")
    return "\n".join(lines)


def build_ticket_text(ticket: dict[str, Any]) -> str:
    ticket_type = str(ticket.get("type", "ticket")).strip().lower()
    if ticket_type == "pdv":
        return build_pdv_ticket_text(ticket)
    if ticket_type == "pdv_resumen":
        return build_pdv_resumen_text(ticket)
    if ticket_type == "historial":
        lines: list[str] = []
        lines.append("HISTORIAL MESAS")
        lines.append("=" * LINE_WIDTH)
        lines.extend(wrap_line(f"Fecha: {current_date_text()}"))
        lines.append("")

        records = ticket.get("history", [])
        if not isinstance(records, list) or not records:
            lines.append("Sin registros")
        else:
            for record in records:
                table_number = record.get("tableNumber", "-")
                lines.extend(wrap_line(f"Mesa {table_number}"))
                items = record.get("items", [])
                if not isinstance(items, list) or not items:
                    lines.extend(wrap_line("- Sin productos"))
                else:
                    for item in items:
                        qty = item.get("qty", 1)
                        name = item.get("name", "Item")
                        lines.extend(wrap_line(f"- {qty}x {name}"))
                total = record.get("total", 0)
                lines.extend(format_with_right("TOTAL:", f"${total}"))
                lines.append("-" * LINE_WIDTH)

        lines.extend(wrap_line(f"Mesera: {ticket.get('mesera', 'Sin nombre')}"))
        lines.append("")
        return "\n".join(lines)

    table_number = ticket.get("tableNumber", "-")
    mesera = ticket.get("mesera", "Sin nombre")
    total = ticket.get("total", 0)
    plates = ticket.get("plates", [])

    lines: list[str] = []
    if ticket_type == "comanda":
        lines.append("COMANDA COCINA")
    else:
        lines.append("Tortas Ahogadas Dona Susy")
        lines.append("Geranio #869")
        lines.append("+52 3336844525")
    lines.append("=" * LINE_WIDTH)
    lines.extend(wrap_line(f"Mesa: {table_number}"))
    lines.extend(wrap_line(f"Fecha: {current_date_text()}"))
    lines.append("")

    for plate_idx, plate in enumerate(plates):
        if plate_idx > 0:
            lines.append("=" * LINE_WIDTH)
        if ticket_type == "comanda":
            lines.extend(wrap_line(f"PLATO {plate_idx + 1}"))
        else:
            lines.extend(wrap_line(f"Plato {plate_idx + 1}"))
        items = plate.get("items", [])
        if not items:
            lines.extend(wrap_line("- Sin productos"))
        for item_idx, item in enumerate(items):
            qty = item.get("qty", 0)
            name = item.get("name", "Item")
            variant = item.get("variant") or ""
            subtotal = item.get("subtotal", 0)
            variant_text = f" ({variant})" if variant else ""
            item_text = f"{qty}x {name}{variant_text}"
            if ticket_type == "comanda":
                lines.extend(wrap_line(f"- {item_text}"))
                if item_idx < len(items) - 1:
                    lines.append("-" * LINE_WIDTH)
            else:
                lines.extend(format_with_right(item_text, f"${subtotal}"))
                if item_idx < len(items) - 1:
                    lines.append("-" * LINE_WIDTH)
        if ticket_type != "comanda":
            lines.append("")

    lines.append("-" * LINE_WIDTH)
    if ticket_type != "comanda":
        lines.extend(format_with_right("TOTAL:", f"${total}"))
        lines.append("Gracias por su preferencia")
    lines.extend(wrap_line(f"Mesera: {mesera}"))
    lines.append("")
    return "\n".join(lines)


def print_text_windows(text: str) -> None:
    printer_name = win32print.GetDefaultPrinter()
    if not printer_name:
        raise RuntimeError("No hay impresora predeterminada configurada")

    hprinter = win32print.OpenPrinter(printer_name)
    hdc = win32ui.CreateDC()
    try:
        hdc.CreatePrinterDC(printer_name)
        hdc.StartDoc("Ticket Dona Susy")
        hdc.StartPage()

        font_normal = win32ui.CreateFont({"name": "Arial", "height": 30, "weight": FW_NORMAL})
        font_big = win32ui.CreateFont({"name": "Arial", "height": 44, "weight": FW_NORMAL})

        y = 20
        for line in text.split("\n"):
            hdc.SelectObject(font_big if line.strip() == "COMANDA COCINA" else font_normal)
            hdc.TextOut(20, y, line.rstrip())
            y += 42 if line.strip() == "COMANDA COCINA" else 30

        hdc.EndPage()
        hdc.EndDoc()
    finally:
        win32print.ClosePrinter(hprinter)


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

