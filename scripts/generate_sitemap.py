#!/usr/bin/env python3
"""Build a Google Search Console sitemap for the public HTML site.

Includes only canonical, indexable pages. lastmod comes from the last git
commit that touched each file (W3C date). Google ignores changefreq/priority;
they are omitted so Search Console does not treat them as freshness signals.
"""
from __future__ import annotations

import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://aegisglobalholdings.com"
OUT = ROOT / "sitemap.xml"

SKIP_NAMES = {
    "thank-you.html",
    "aegisos-early-access.html",
    "aegis-founding-rate.html",
}


def git_lastmod(path: Path) -> str | None:
    result = subprocess.run(
        ["git", "log", "-1", "--format=%cs", "--", str(path.relative_to(ROOT))],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    date = result.stdout.strip()
    return date or None


def loc_for(rel: Path) -> str:
    if rel.as_posix() == "index.html":
        return f"{ORIGIN}/"
    return f"{ORIGIN}/{rel.as_posix()}"


def public_pages() -> list[Path]:
    pages = []
    for path in ROOT.rglob("*.html"):
        rel = path.relative_to(ROOT)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if rel.name in SKIP_NAMES:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if 'name="robots"' in text and "noindex" in text:
            continue
        pages.append(path)
    pages.sort(
        key=lambda p: (
            p.relative_to(ROOT).as_posix() != "index.html",
            p.relative_to(ROOT).as_posix(),
        )
    )
    return pages


def build() -> str:
    urlset = ET.Element("urlset", xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")
    for path in public_pages():
        rel = path.relative_to(ROOT)
        url = ET.SubElement(urlset, "url")
        ET.SubElement(url, "loc").text = loc_for(rel)
        lastmod = git_lastmod(path)
        if lastmod:
            ET.SubElement(url, "lastmod").text = lastmod
    ET.indent(urlset, space="  ")
    xml = ET.tostring(urlset, encoding="unicode", xml_declaration=False)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + xml + "\n"


def main() -> None:
    body = build()
    OUT.write_text(body, encoding="utf-8")
    count = body.count("<loc>")
    print(f"wrote {OUT.relative_to(ROOT)} ({count} URLs)")


if __name__ == "__main__":
    main()
