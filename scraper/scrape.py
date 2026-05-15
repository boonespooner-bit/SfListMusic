#!/usr/bin/env python3
"""Scrapes jon.luini.com/thelist/date.html and writes public/data.json."""

import json
import re
import sys
from datetime import date, datetime
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
    # Bands are separated by <BR> tags
    for part in cell.decode_contents().split("<br"):
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


def infer_year(month_num: int, current_year: int, last_year: int) -> int:
    """Roll over to next year when month resets (e.g. Dec -> Jan)."""
    if last_year and month_num < last_year:
        return current_year + 1
    return current_year


def parse_page(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    results: list[dict] = []

    now = datetime.utcnow()
    current_year = now.year
    last_month_num = 0

    # Each month is a separate <table>
    for table in soup.find_all("table"):
        # Identify month from the gold header row
        header_row = table.find("tr", bgcolor=lambda v: v and v.upper() in ("#FFCC00", "FFCC00"))
        if not header_row:
            continue

        month_text = header_row.get_text(" ", strip=True).lower()
        month_num = next((v for k, v in MONTH_NAMES.items() if k in month_text), None)
        if month_num is None:
            continue

        if month_num < last_month_num:
            current_year += 1
        last_month_num = month_num

        current_date_str = None
        current_day_name = None

        rows = table.find_all("tr")
        for row in rows:
            cells = row.find_all("td")
            if not cells:
                continue

            # Date cell is yellow: BGCOLOR="#CCCC00"
            date_cell = row.find("td", bgcolor=lambda v: v and v.upper() in ("#CCCC00", "CCCC00"))
            if date_cell:
                raw = clean_text(date_cell)
                # e.g. "Friday 15" or "Fri 15"
                parts = raw.split()
                current_day_name = parts[0] if parts else ""
                day_num = int(re.search(r'\d+', raw).group()) if re.search(r'\d+', raw) else 0
                dt = date(current_year, month_num, day_num)
                current_date_str = dt.isoformat()

            if not current_date_str:
                continue

            # A show row has band + venue + details (3 non-date cells, or 2 if date cell present)
            non_date_cells = [c for c in cells if c != date_cell]
            if len(non_date_cells) < 3:
                continue

            bands_cell, venue_cell, details_cell = non_date_cells[0], non_date_cells[1], non_date_cells[2]

            bands = parse_bands(bands_cell)
            if not bands:
                continue

            venue = parse_venue(venue_cell)
            details = parse_details(details_cell)

            show = {
                "date": current_date_str,
                "dayName": current_day_name,
                "bands": bands,
                "venue": venue,
                **details,
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

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "updated": datetime.utcnow().isoformat() + "Z",
        "source": SOURCE_URL,
        "shows": shows,
    }
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"Written to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
