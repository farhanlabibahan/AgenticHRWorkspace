"""Writes tests/support/clients.xlsx with openpyxl: an independent writer, so
the reader in src/server/spreadsheet.ts isn't only tested against itself.
Fictional companies.

    python3 -m venv v && v/bin/pip install openpyxl && v/bin/python tests/support/make-clients-xlsx.py
"""
from pathlib import Path
from openpyxl import Workbook
from openpyxl.cell.rich_text import CellRichText, TextBlock
from openpyxl.cell.text import InlineFont

wb = Workbook()
ws = wb.active
ws.title = "Clients"
ws.append(["#", "Company name", "Owner"])
ws.append([1, "Acme, Inc.", "Rowan Q. Testperson"])
ws.append([2, "Zoë Studio GmbH", "Rowan Q. Testperson"])
ws.append([3, "acme, inc.", "the same company, other case"])
ws.append([None, None, None])
ws.append([4, CellRichText([TextBlock(InlineFont(b=True), "Initech"), " Labs"]), "rich text"])
ws.append([5, 42, "a number, not a name"])
wb.create_sheet("Archive").append(["Should not be read"])

out = Path(__file__).with_name("clients.xlsx")
wb.save(out)
print(out, out.stat().st_size, "bytes")
