#!/usr/bin/env python3
"""Scrapes jon.luini.com/thelist/date.html and writes public/data.json."""

import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

SOURCE_URL = "https://jon.luini.com/thelist/date.html"
OUTPUT_PATH = Path(__file__).parent.parent / "public" / "data.json"

SYMBOL_MAP = {
    "*": "all bands deserve 3 stars",
    "~": "will probably sell out",
    "@": "mosh pit warning",
    "^": "under 21 must pay more",
    "#": "no ins/outs",
}

MONTH_NAMES = {
    "january": 1, "february": 2, "march": 3, "april": 4,
    "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
}

AGE_RE = re.compile(r'\b(a/a|all\s*ages|21\+|18\+|16\+)\b', re.I)
PRICE_RE = re.compile(r'\$[\d/\.]+(?:\s*/\s*\$[\d/\.]+)?')
TIME_RE = re.compile(r'\b(\d{1,2}(?::\d{2})?(?:am|pm))\b', re.I)


def fetch_html(url: str) -> str:
    resp = requests.get(url, timeout=30, headers={"User-Agent": "SfListMusic-Mirror/1.0"})
    resp.raise_for_status()
    return resp.text


def parse_symbols(text: str) -> list[str]:
    return [s for s in SYMBOL_MAP if s in text]


def clean_text(element) -> str:
    return " ".join(element.get_text(" ", strip=True).split())


def parse_details(cell) -> dict:
    text = clean_text(cell)
    result = {}

    age_match = AGE_RE.search(text)
    if age_match:
        raw = age_match.group(1).lower().replace(" ", "")
        result["age"] = "all ages" if raw in ("a/a", "allages") else age_match.group(1)

    price_match = PRICE_RE.search(text)
    if price_match:
        result["price"] = price_match.group(0).strip()

    times = TIME_RE.findall(text)
    if times:
        result["doors"] = times[0] if len(times) >= 1 else None
        result["show"] = times[1] if len(times) >= 2 else None

    result["symbols"] = parse_symbols(text)

    # Everything that isn't age/price/time/symbols is "notes"
    leftover = text
    for pat in [AGE_RE, PRICE_RE, TIME_RE]:
        leftover = pat.sub("", leftover)
    for sym in SYMBOL_MAP:
        leftover = leftover.replace(sym, "")
    notes = " ".join(leftover.split()).strip(" -,;|")
    if notes:
        result["notes"] = notes

    return result


def parse_bands(cell) -> list[str]:
    bands = []
    # Bands are separated by <BR> tags; split and strip residual tag chars
    for part in re.split(r'<br', cell.decode_contents(), flags=re.IGNORECASE):
        part = re.sub(r'^[/>\s]+', '', part)  # strip leftover /> or > from <br/>
        text = BeautifulSoup(part, "lxml").get_text(" ", strip=True)
        text = re.sub(r'\s+', ' ', text).strip()
        if text:
            bands.append(text)
    return [b for b in bands if b]


def parse_venue(cell) -> dict:
    a = cell.find("a")
    if a:
        return {"name": clean_text(a), "url": a.get("href", "")}
    return {"name": clean_text(cell), "url": ""}


MONTH_YEAR_RE = re.compile(
    r'(' + '|'.join(MONTH_NAMES.keys()) + r')[,\s]+(\d{4})',
    re.IGNORECASE
)


def is_date_cell(td) -> bool:
    bg = (td.get("bgcolor") or "").upper().replace(" ", "")
    return bg in ("#CCCC00", "CCCC00")


def find_month_year(text: str) -> tuple[int, int] | None:
    """Return (month_num, year) from text like 'May 2026', or None."""
    m = MONTH_YEAR_RE.search(text)
    if m:
        return MONTH_NAMES[m.group(1).lower()], int(m.group(2))
    return None


def parse_page(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    results: list[dict] = []

    now = datetime.now(timezone.utc)
    fallback_month, fallback_year = now.month, now.year

    # Index every element by its position in document order so we can find
    # the "nearest preceding month mention" for each show table.
    all_elems = list(soup.find_all(True))
    elem_pos = {id(e): i for i, e in enumerate(all_elems)}

    # Collect (position, month_num, year) for every month+year mention on the page.
    month_markers: list[tuple[int, int, int]] = []
    for elem in all_elems:
        if elem.name in ("h1","h2","h3","h4","b","font","td","th","p","title","li"):
            result = find_month_year(elem.get_text(" ", strip=True))
            if result:
                month_markers.append((elem_pos[id(elem)], result[0], result[1]))

    # Find every table that has at least one date cell (bgcolor=#CCCC00).
    show_tables: list[tuple[int, object]] = []
    for table in soup.find_all("table"):
        if any(is_date_cell(td) for td in table.find_all("td")):
            show_tables.append((elem_pos.get(id(table), 0), table))

    print(f"  Show tables: {len(show_tables)}")
    print(f"  Month markers: {[(m, y) for _, m, y in month_markers[:10]]}")

    for table_pos, table in show_tables:
        # Use the nearest preceding month marker; fall back to checking the
        # table's own text (month row may be inside the table without bgcolor).
        preceding = [(p, m, y) for p, m, y in month_markers if p <= table_pos]
        if preceding:
            _, month_num, year = max(preceding, key=lambda x: x[0])
        else:
            # Try scanning inside the table itself
            result = find_month_year(table.get_text(" ", strip=True))
            month_num, year = result if result else (fallback_month, fallback_year)

        current_date_str = None
        current_day_name = None

        for row in table.find_all("tr"):
            cells = row.find_all("td")
            if not cells:
                continue

            # A row that contains only a month+year string is a section header.
            row_text = row.get_text(" ", strip=True)
            row_result = find_month_year(row_text)
            if row_result and not any(is_date_cell(c) for c in cells):
                month_num, year = row_result
                continue

            date_cell = next((c for c in cells if is_date_cell(c)), None)
            if date_cell:
                raw = clean_text(date_cell)
                parts = raw.split()
                current_day_name = parts[0] if parts else ""
                day_match = re.search(r'\d+', raw)
                if day_match:
                    try:
                        dt = date(year, month_num, int(day_match.group()))
                        current_date_str = dt.isoformat()
                    except ValueError:
                        current_date_str = None

            if not current_date_str:
                continue

            non_date_cells = [c for c in cells if c is not date_cell]
            if len(non_date_cells) < 3:
                continue

            bands_cell, venue_cell, details_cell = non_date_cells[0], non_date_cells[1], non_date_cells[2]
            bands = parse_bands(bands_cell)
            if not bands:
                continue

            show = {
                "date": current_date_str,
                "dayName": current_day_name,
                "bands": bands,
                "venue": parse_venue(venue_cell),
                **parse_details(details_cell),
                "spotifyUrl": None,
                "youtubeUrl": None,
            }
            results.append(show)

    return results


def main():
    print(f"Fetching {SOURCE_URL}…")
    try:
        html = fetch_html(SOURCE_URL)
    except Exception as e:
        print(f"ERROR fetching source: {e}", file=sys.stderr)
        sys.exit(1)

    print("Parsing…")
    shows = parse_page(html)
    print(f"  Found {len(shows)} shows")
    if not shows:
        print("  WARNING: 0 shows parsed — first 800 chars of HTML:")
        print(html[:800])

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "source": SOURCE_URL,
        "shows": shows,
    }
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"Written to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
