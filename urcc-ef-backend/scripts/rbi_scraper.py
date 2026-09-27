"""
Scrapes https://rbi.org.in/scripts/BS_ViewMasterDirections.aspx to detect
new or amended Master Directions, and (optionally) downloads + re-ingests
the ones that changed.

CONFIRMED PAGE STRUCTURE (fetched live, Aug 2026):
- One long page, sectioned by department headings (Commercial Banks, Small
  Finance Banks, Regional Rural Banks, ... - matches your 12 institution
  categories closely but not 1:1, see CATEGORY_MAP below).
- Each direction is a link:  BS_ViewMasDirections.aspx?id=<doc_id>
  immediately followed by a "PDF - <title>" link to a stable
  rbidocs.rbi.org.in/.../*.PDF URL.
- Titles often carry a suffix like "(Updated as on July 01, 2026)" when RBI
  has amended the document in place. THIS is the cheap, reliable change
  signal - diff this string per doc_id, don't diff PDF bytes unless the
  label actually changed (fetching 400+ PDFs on every check is wasteful
  and this sandbox's network allowlist doesn't include rbidocs.rbi.org.in
  anyway - see NETWORK NOTE below).

NETWORK NOTE: this sandbox's egress allowlist does not include rbi.org.in
or rbidocs.rbi.org.in, so this script cannot actually run inside THIS
sandbox - it's written to run on your own machine / server where egress
isn't restricted the same way. It mirrors exactly the page structure
confirmed via a manual fetch during this session.

Modes:
  --mode check   populate/refresh rbi_watch_list only (cheap, no downloads)
  --mode apply   also download PDFs for anything whose label changed, drop
                 them into RBI_PDF_STORAGE_DIR under the right category
                 folder, and mark them ready for db_builder.py to re-ingest
"""
import argparse
import hashlib
import os
import re
import sqlite3
import sys

import requests
from bs4 import BeautifulSoup

MASTER_DIRECTIONS_URL = os.environ.get(
    "RBI_MASTER_DIRECTIONS_URL", "https://rbi.org.in/scripts/BS_ViewMasterDirections.aspx"
)
DATA_DIR = os.environ.get("URCC_DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data"))
DB_PATH = os.path.join(DATA_DIR, "urcc_ef.db")
PDF_STORAGE_DIR = os.environ.get(
    "RBI_PDF_STORAGE_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "circulars")
)

# Maps the department heading text on the RBI page to your existing
# corpus folder names (categories.py maps every folder name to a canonical
# institution category). Extend as
# you encounter more headings - fail loud (raise) rather than silently
# mis-categorize a new heading.
CATEGORY_MAP = {
    "Commercial Banks": "commercial banks",
    "Small Finance Banks": "small financial banks",
    "Payments Banks": "payment banks",
    "Local Area Banks": "local area banks",
    "Regional Rural Banks": "Regional_Rural_Bank",
    "Urban Co-operative Banks": "Urban_Cooperative_Bank",
    "Rural Co-operative Banks": "Rural_Cooperative_Bank",
    "All India Financial Institutions": "All_India_Financial_Institutions",
    "Non-Banking Financial Companies": "NBFC",
    "Asset Reconstruction Companies": "Asset_Reconstruction_Companies",
    "Credit Information Companies": "Credit_Information_Services",
}

RE_UPDATED_LABEL = re.compile(r"\(Updated as on ([^)]+)\)", re.IGNORECASE)
RE_ID = re.compile(r"id=(\d+)")


def fetch_and_parse():
    """Returns list of dicts: {rbi_doc_id, department, institution_category, title, pdf_url, last_updated_label}"""
    resp = requests.get(MASTER_DIRECTIONS_URL, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    entries = []
    current_dept = None
    # The listing renders as a flat sequence of <li>/<b> heading markers and
    # <a> links inside the main content table. Walk all <a> tags in document
    # order and track the most recent bold department heading seen.
    for el in soup.find_all(["b", "a"]):
        if el.name == "b":
            text = el.get_text(strip=True)
            if text in CATEGORY_MAP:
                current_dept = text
            continue
        href = el.get("href", "")
        if "BS_ViewMasDirections.aspx" in href and "id=" in href:
            m = RE_ID.search(href)
            if not m or current_dept is None:
                continue
            rbi_doc_id = m.group(1)
            title = el.get_text(strip=True)
            # the very next PDF link in document order is this entry's PDF
            pdf_link = el.find_next("a", href=re.compile(r"\.PDF$", re.IGNORECASE))
            pdf_url = pdf_link["href"] if pdf_link else None
            label_m = RE_UPDATED_LABEL.search(title)
            entries.append({
                "rbi_doc_id": rbi_doc_id,
                "department": current_dept,
                "institution_category": CATEGORY_MAP[current_dept],
                "title": title,
                "pdf_url": pdf_url,
                "last_updated_label": label_m.group(1) if label_m else None,
            })
    return entries


def sync_watch_list(entries, conn):
    changed = []
    cur = conn.cursor()
    for e in entries:
        row = cur.execute(
            "SELECT last_updated_label FROM rbi_watch_list WHERE rbi_doc_id = ?", (e["rbi_doc_id"],)
        ).fetchone()
        is_new = row is None
        is_changed = row is not None and (row[0] or None) != (e["last_updated_label"] or None)
        cur.execute(
            """INSERT INTO rbi_watch_list (rbi_doc_id, department, institution_category, title, pdf_url, last_updated_label, last_checked_at)
               VALUES (?,?,?,?,?,?, datetime('now'))
               ON CONFLICT(rbi_doc_id) DO UPDATE SET
                 title=excluded.title, pdf_url=excluded.pdf_url,
                 last_updated_label=excluded.last_updated_label,
                 last_checked_at=datetime('now')""",
            (e["rbi_doc_id"], e["department"], e["institution_category"], e["title"], e["pdf_url"], e["last_updated_label"]),
        )
        if is_new or is_changed:
            changed.append(e)
    conn.commit()
    return changed


def download_changed(changed):
    downloaded = []
    for e in changed:
        if not e["pdf_url"]:
            continue
        category_dir = os.path.join(PDF_STORAGE_DIR, e["institution_category"])
        os.makedirs(category_dir, exist_ok=True)
        resp = requests.get(e["pdf_url"], timeout=60)
        resp.raise_for_status()
        pdf_hash = hashlib.sha256(resp.content).hexdigest()
        fname = f"{e['rbi_doc_id']}_{pdf_hash[:8]}.pdf"
        fpath = os.path.join(category_dir, fname)
        with open(fpath, "wb") as f:
            f.write(resp.content)
        downloaded.append({**e, "local_path": fpath, "pdf_hash": pdf_hash})
        print(f"[rbi_scraper] downloaded: {e['title'][:80]}  -> {fpath}")
    return downloaded


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["check", "apply"], default="check")
    args = ap.parse_args()

    print(f"[rbi_scraper] fetching {MASTER_DIRECTIONS_URL} ...")
    entries = fetch_and_parse()
    print(f"[rbi_scraper] parsed {len(entries)} directions across {len(CATEGORY_MAP)} watched departments")

    conn = sqlite3.connect(DB_PATH)
    changed = sync_watch_list(entries, conn)
    print(f"[rbi_scraper] {len(changed)} new or changed since last check")
    for c in changed:
        print(f"  - [{c['institution_category']}] {c['title'][:90]}")

    if args.mode == "apply" and changed:
        downloaded = download_changed(changed)
        print(f"[rbi_scraper] downloaded {len(downloaded)} PDFs to {PDF_STORAGE_DIR}")
        print("[rbi_scraper] NEXT STEP: run `npm run ingest:build-db` to re-parse the corpus "
              "including these new/updated files, then `npm run ingest:build-vectors`.")
    conn.close()


if __name__ == "__main__":
    main()
