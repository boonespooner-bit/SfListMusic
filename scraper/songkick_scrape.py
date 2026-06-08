#!/usr/bin/env python3
"""Scrapes upcoming Bay Area shows from Songkick and merges into public/data.json.

Deduplicates by (date, normalized-venue-name):
  - Existing show at same venue+date → merge in any new bands only.
  - New venue+date combo → append the whole show.

Runs AFTER scrape.py so it only adds to the existing dataset.
"""

import json
import re
import sys
import time
from datetime import date as date_cls, datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

DATA_PATH = Path(__file__).parent.parent / "public" / "data.json"
SONGKICK_URL = "https://www.songkick.com/metro-areas/26330-us-sf-bay-area"
MAX_PAGES = 15

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
}


# ── Normalisation ─────────────────────────────────────────────────────────────

def normalize_venue(name: str) -> str:
    """Lowercase, strip leading 'the', remove punctuation — for fuzzy matching."""
    name = name.lower().strip()
    name = re.sub(r"^the\s+", "", name)
    name = re.sub(r"[^a-z0-9\s]", "", name)
    return re.sub(r"\s+", " ", name).strip()


def normalize_band(name: str) -> str:
    return re.sub(r"\s+", " ", name.lower().strip())


def venues_match(a: str, b: str) -> bool:
    na, nb = normalize_venue(a), normalize_venue(b)
    return na == nb or na in nb or nb in na


# ── Fetching ──────────────────────────────────────────────────────────────────

def fetch_page(page: int) -> str | None:
    params = {"page": page} if page > 1 else {}
    try:
        r = requests.get(SONGKICK_URL, headers=HEADERS, params=params, timeout=20)
        if r.status_code == 429:
            print("  Songkick rate-limited (429) — stopping pagination.", flush=True)
            return None
        r.raise_for_status()
        return r.text
    except Exception as e:
        print(f"  Fetch error page {page}: {e}", flush=True)
        return None


# ── Parsing strategies ────────────────────────────────────────────────────────

def try_nextjs_json(html: str) -> list[dict]:
    """Extract events from Next.js __NEXT_DATA__ blob if present."""
    soup = BeautifulSoup(html, "lxml")
    tag = soup.find("script", id="__NEXT_DATA__")
    if not tag:
        return []
    try:
        data = json.loads(tag.string)
    except Exception:
        return []

    # Walk the props tree looking for any list of objects with startDate/performer/location
    events = []
    def walk(obj):
        if isinstance(obj, list):
            for item in obj:
                walk(item)
        elif isinstance(obj, dict):
            if obj.get("startDate") and (obj.get("performer") or obj.get("location")):
                events.append(obj)
            else:
                for v in obj.values():
                    walk(v)
    walk(data)
    return events


def try_jsonld(html: str) -> list[dict]:
    """Extract MusicEvent objects from JSON-LD <script> tags."""
    soup = BeautifulSoup(html, "lxml")
    events = []
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
        except Exception:
            continue
        items = data if isinstance(data, list) else data.get("@graph", [data])
        for item in items:
            if isinstance(item, dict) and item.get("@type") == "MusicEvent":
                events.append(item)
    return events


def try_html(html: str) -> list[dict]:
    """Fallback: scrape Songkick event listing HTML directly."""
    soup = BeautifulSoup(html, "lxml")
    raw = []

    selectors = [
        "li.event-listings-element",
        "li[class*='event-listings']",
        "article[class*='event']",
        "div[class*='event-listing']",
    ]
    items = []
    for sel in selectors:
        items = soup.select(sel)
        if items:
            break

    for item in items:
        # Artist
        for a_sel in [".artists strong", ".summary strong", "strong.artists", "h3"]:
            el = item.select_one(a_sel)
            if el:
                artist = el.get_text(strip=True)
                break
        else:
            continue

        # Venue
        venue = ""
        for v_sel in [".venue-name", "[class*='venue-name']", ".location em"]:
            el = item.select_one(v_sel)
            if el:
                venue = el.get_text(strip=True)
                break

        # Date
        time_el = item.select_one("time[datetime]")
        date_str = (time_el["datetime"][:10] if time_el else "")

        if artist and venue and date_str:
            raw.append({"artist": artist, "venue": venue, "date": date_str})

    return raw


# ── Normalise to internal show format ─────────────────────────────────────────

def event_to_show(ev: dict) -> dict | None:
    """Convert a JSON-LD / Next.js MusicEvent dict to our show format."""
    try:
        start = ev.get("startDate", "")
        if not start:
            return None
        iso_date = start[:10]

        location = ev.get("location", {})
        if isinstance(location, list):
            location = location[0] if location else {}
        venue_name = (location.get("name") or "").strip()
        if not venue_name:
            return None

        performers = ev.get("performer", [])
        if isinstance(performers, dict):
            performers = [performers]
        bands = [p.get("name", "").strip() for p in (performers or []) if p.get("name")]

        if not bands:
            name = ev.get("name", "")
            if " at " in name:
                bands = [name.split(" at ")[0].strip()]
            else:
                bands = [name.strip()]
        bands = [b for b in bands if b]
        if not bands:
            return None

        try:
            y, m, d = map(int, iso_date.split("-"))
            day_name = date_cls(y, m, d).strftime("%A")
        except Exception:
            day_name = ""

        # Ticket URL from offers
        ticket_url = ""
        offers = ev.get("offers", {})
        if isinstance(offers, list):
            offers = offers[0] if offers else {}
        if isinstance(offers, dict):
            ticket_url = offers.get("url", "")

        return {
            "date": iso_date,
            "dayName": day_name,
            "bands": bands,
            "venue": {"name": venue_name, "url": ticket_url},
            "source": "songkick",
            "spotifyUrl": None,
            "youtubeUrl": None,
        }
    except Exception as e:
        print(f"  event_to_show error: {e}", flush=True)
        return None


def raw_html_to_show(r: dict) -> dict | None:
    try:
        y, m, d = map(int, r["date"].split("-"))
        day_name = date_cls(y, m, d).strftime("%A")
    except Exception:
        day_name = ""
    return {
        "date": r["date"],
        "dayName": day_name,
        "bands": [r["artist"]],
        "venue": {"name": r["venue"], "url": ""},
        "source": "songkick",
        "spotifyUrl": None,
        "youtubeUrl": None,
    }


# ── Scrape all pages ──────────────────────────────────────────────────────────

def scrape_songkick() -> list[dict]:
    shows: list[dict] = []
    seen: set[str] = set()    # date|norm-venue

    today = datetime.now(timezone.utc).date().isoformat()

    for page in range(1, MAX_PAGES + 1):
        print(f"  Fetching Songkick page {page}…", flush=True)
        html = fetch_page(page)
        if not html:
            break

        # Strategy 1: Next.js JSON blob
        raw_events = try_nextjs_json(html)
        strategy = "next.js"

        # Strategy 2: JSON-LD
        if not raw_events:
            raw_events = try_jsonld(html)
            strategy = "json-ld"

        page_shows: list[dict] = []

        if raw_events:
            print(f"    {strategy}: {len(raw_events)} events", flush=True)
            for ev in raw_events:
                show = event_to_show(ev)
                if show:
                    page_shows.append(show)
        else:
            # Strategy 3: HTML fallback
            raw_html = try_html(html)
            print(f"    html-fallback: {len(raw_html)} events", flush=True)
            if not raw_html:
                # Nothing on this page — log a snippet for debugging
                print(f"    No events found. HTML snippet:", flush=True)
                print(html[:600], flush=True)
                break
            for r in raw_html:
                show = raw_html_to_show(r)
                if show:
                    page_shows.append(show)

        added = 0
        for show in page_shows:
            if show["date"] < today:
                continue
            key = f"{show['date']}|{normalize_venue(show['venue']['name'])}"
            if key not in seen:
                seen.add(key)
                shows.append(show)
                added += 1

        print(f"    Added {added} new shows (running total: {len(shows)})", flush=True)

        if not page_shows:
            break

        time.sleep(1.5)  # be a polite scraper

    return shows


# ── Dedup + merge into data.json ──────────────────────────────────────────────

def merge_shows(existing: list[dict], new_shows: list[dict]) -> tuple[int, int]:
    """
    Merge new_shows into existing in-place.
    Returns (bands_added, shows_added).
    """
    bands_added = shows_added = 0

    # Build lookup: (date, norm-venue) → existing show
    lookup: dict[str, dict] = {}
    for show in existing:
        key = f"{show['date']}|{normalize_venue(show['venue']['name'])}"
        lookup[key] = show

    for new in new_shows:
        new_key = f"{new['date']}|{normalize_venue(new['venue']['name'])}"

        # Exact key match first
        if new_key in lookup:
            existing_show = lookup[new_key]
        else:
            # Fuzzy: same date, venue names overlap
            existing_show = None
            for key, show in lookup.items():
                if show["date"] == new["date"] and venues_match(show["venue"]["name"], new["venue"]["name"]):
                    existing_show = show
                    break

        if existing_show is not None:
            # Merge new bands not already present
            existing_bands = {
                normalize_band(b if isinstance(b, str) else b.get("name", ""))
                for b in existing_show["bands"]
            }
            for band in new["bands"]:
                nb = normalize_band(band)
                if nb and nb not in existing_bands:
                    existing_show["bands"].append(band)
                    existing_bands.add(nb)
                    bands_added += 1
        else:
            existing.append(new)
            lookup[new_key] = new
            shows_added += 1

    return bands_added, shows_added


def main():
    if not DATA_PATH.exists():
        print("data.json not found — run scrape.py first", file=sys.stderr)
        sys.exit(1)

    payload = json.loads(DATA_PATH.read_text())
    existing: list[dict] = payload.get("shows", [])
    print(f"Existing shows: {len(existing)}", flush=True)

    print(f"Scraping Songkick ({SONGKICK_URL})…", flush=True)
    new_shows = scrape_songkick()
    print(f"Songkick shows fetched: {len(new_shows)}", flush=True)

    if not new_shows:
        print("No Songkick shows retrieved — data.json unchanged.", flush=True)
        return

    bands_added, shows_added = merge_shows(existing, new_shows)
    print(f"Merge complete: {shows_added} new shows added, {bands_added} new bands merged into existing shows.", flush=True)

    payload["shows"] = existing
    payload["updated"] = datetime.now(timezone.utc).isoformat()
    DATA_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"data.json updated ({len(existing)} total shows).", flush=True)


if __name__ == "__main__":
    main()
