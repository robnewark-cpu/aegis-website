#!/usr/bin/env python3
"""Render content/resources/**/*.md into public HTML under resources/."""
from __future__ import annotations

import html
import json
import re
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "content" / "resources"
OUT = ROOT / "resources"

FM_RE = re.compile(r"^---\n(.*?)\n---\n(.*)$", re.S)

WIDGET = """  <script
  src="https://site-chatbot-assets.pages.dev/widget.js"
  data-worker-url="https://site-chatbots.robert-bb6.workers.dev"
  data-site="aegis"
  data-name="Aegis Global Holdings"
  data-accent="#0F1B2E"
  data-greeting="Hi, I'm the Aegis assistant. I can answer questions about our services, AegisOS products, or help you book a demo."
  async
  defer></script>"""


def parse_front_matter(raw: str) -> tuple[dict, str]:
    m = FM_RE.match(raw)
    if not m:
        return {}, raw
    meta: dict = {}
    for line in m.group(1).splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, val = line.split(":", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            meta[key] = [p.strip().strip('"').strip("'") for p in inner.split(",") if p.strip()]
        else:
            meta[key] = val
    return meta, m.group(2)


def rewrite_links(html: str, depth: int) -> str:
    prefix = "../" * depth
    # Markdown relative product links written as /lexflow.html or lexflow.html
    def repl(match: re.Match) -> str:
        href = match.group(1)
        if href.startswith(("http://", "https://", "mailto:", "#")):
            return match.group(0)
        if href.startswith("/"):
            href = href.lstrip("/")
        return f'href="{prefix}{href}"'

    return re.sub(r'href="([^"]+)"', repl, html)


def extract_faq(md_body: str) -> list[dict]:
    faqs = []
    # ### What is ... \n\n paragraph
    parts = re.split(r"\n###\s+", md_body)
    for part in parts[1:]:
        lines = part.strip().splitlines()
        if not lines:
            continue
        q = lines[0].strip()
        ans = " ".join(ln.strip() for ln in lines[1:] if ln.strip() and not ln.startswith("#"))
        ans = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", ans)
        if q.lower().startswith(("what ", "how ", "why ", "when ", "who ", "where ", "is ", "are ", "can ", "should ", "do ", "does ")):
            if 20 < len(ans) < 1200:
                faqs.append({"q": q, "a": ans[:900]})
        if len(faqs) >= 10:
            break
    return faqs


def page_html(meta: dict, body_html: str, rel_depth: int, canonical: str, faqs: list[dict]) -> str:
    title = html.escape(meta.get("meta_title") or meta.get("seo_title") or meta.get("h1") or "Aegis Knowledge Center")
    desc = html.escape(meta.get("meta_description") or "")
    h1 = html.escape(meta.get("h1") or title, quote=False)
    cluster = (meta.get("cluster") or "").title()
    prefix = "../" * rel_depth
    faq_ld = ""
    if faqs:
        faq_ld = json.dumps(
            {
                "@context": "https://schema.org",
                "@type": "FAQPage",
                "mainEntity": [
                    {
                        "@type": "Question",
                        "name": f["q"],
                        "acceptedAnswer": {"@type": "Answer", "text": f["a"]},
                    }
                    for f in faqs
                ],
            },
            indent=2,
        )
    article_ld = json.dumps(
        {
            "@context": "https://schema.org",
            "@type": "Article",
            "headline": h1,
            "description": desc,
            "datePublished": "2026-08-27",
            "dateModified": "2026-08-27",
            "author": {
                "@type": "Organization",
                "name": "Aegis Global Holdings, LLC",
                "url": "https://aegisglobalholdings.com/",
            },
            "publisher": {
                "@type": "Organization",
                "name": "Aegis Global Holdings, LLC",
                "url": "https://aegisglobalholdings.com/",
            },
            "mainEntityOfPage": canonical,
            "url": canonical,
        },
        indent=2,
    )
    faq_script = f'\n  <script type="application/ld+json">\n{faq_ld}\n  </script>' if faq_ld else ""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <meta name="description" content="{desc}">
  <link rel="canonical" href="{canonical}">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{desc}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="{canonical}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="stylesheet" href="{prefix}styles.css">
  <link rel="icon" href="{prefix}favicon.svg" type="image/svg+xml">
  <link rel="alternate" type="text/plain" href="https://aegisglobalholdings.com/llms.txt" title="LLM information">
  <script type="application/ld+json">
{article_ld}
  </script>{faq_script}
</head>
<body>
  <header class="site-header">
    <div class="container">
      <a class="brand" href="{prefix}index.html">AEGIS<span class="accent"></span></a>
      <nav class="main-nav" aria-label="Primary">
        <ul>
        <li><a href="{prefix}index.html#services">Services</a></li>
        <li><a href="{prefix}index.html#about">About</a></li>
        <li><a href="{prefix}blog.html">Blog</a></li>
        <li><a href="{prefix}resources/index.html" aria-current="page">Knowledge Center</a></li>
        <li><a href="{prefix}aegisos.html">AegisOS</a></li>
        <li><a href="{prefix}book-demo.html">Book a Demo</a></li>
        <li><a href="{prefix}index.html#contact">Contact</a></li>
        </ul>
      </nav>
      <span class="badge-flag">&#127482;&#127480; Veteran-Owned Business</span>
    </div>
  </header>
  <main>
    <section class="hero">
      <div class="container">
        <span class="kc-hero-kicker">Knowledge Center{f" · {cluster}" if cluster else ""}</span>
        <h1>{h1}</h1>
        <p class="article-meta">Educational resource · Updated 27 August 2026 · Aegis Global Holdings, LLC</p>
      </div>
    </section>
    <section class="alt">
      <div class="container">
        <article class="prose">
{body_html}
          <p class="disclaimer">This article is educational and is not legal, tax, lending, banking, or compliance advice. Confirm current rules with qualified counsel and the relevant regulator or court. Aegis product capabilities should be confirmed against current product pages and a live demonstration.</p>
        </article>
      </div>
    </section>
  </main>
  <footer class="site-footer">
    <div class="container">
      <div class="foot-grid">
        <div>
          <h4>Company</h4>
          <ul>
            <li><a href="{prefix}resources/index.html">Knowledge Center</a></li>
            <li><a href="{prefix}index.html#services">Services</a></li>
            <li><a href="{prefix}security.html">Security</a></li>
            <li><a href="{prefix}blog.html">Blog</a></li>
            <li><a href="{prefix}book-demo.html">Book a Demo</a></li>
            <li><a href="{prefix}index.html#contact">Contact</a></li>
          </ul>
        </div>
        <div>
          <h4>Products</h4>
          <ul>
          <li><a href="{prefix}aegisos.html">AegisOS</a></li>
          <li><a href="{prefix}aegispay.html">AegisPay</a></li>
          <li><a href="{prefix}lexflow.html">LexFlow</a></li>
          <li><a href="{prefix}loanserv.html">LoanServ</a></li>
          </ul>
        </div>
        <div>
          <h4>Location</h4>
          <ul>
            <li>Edmond, Oklahoma</li>
            <li><a href="mailto:info@aegisglobalholdings.com">info@aegisglobalholdings.com</a></li>
          </ul>
        </div>
        <div>
          <h4>Legal</h4>
          <ul>
            <li><a href="{prefix}privacy-policy.html">Privacy Policy</a></li>
            <li><a href="{prefix}terms-of-service.html">Terms of Service</a></li>
          </ul>
        </div>
      </div>
      <div class="legal">
        <p>&copy; 2026 Aegis Global Holdings, LLC. All rights reserved.</p>
      </div>
    </div>
  </footer>
{WIDGET}
</body>
</html>
"""


def render_file(md_path: Path) -> None:
    raw = md_path.read_text(encoding="utf-8")
    meta, body = parse_front_matter(raw)
    slug = meta.get("slug") or md_path.stem
    cluster = meta.get("cluster") or md_path.parent.name
    canonical = meta.get("canonical") or f"https://aegisglobalholdings.com/resources/{cluster}/{slug}.html"
    html_body = markdown.markdown(
        body,
        extensions=["tables", "fenced_code", "sane_lists", "toc"],
        extension_configs={"toc": {"permalink": False}},
    )
    rel_depth = 2 if cluster != "resources" else 1
    html_body = rewrite_links(html_body, rel_depth)
    faqs = extract_faq(body)
    out_dir = OUT / cluster
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{slug}.html").write_text(
        page_html(meta, html_body, rel_depth, canonical, faqs), encoding="utf-8"
    )


def main() -> None:
    files = [p for p in SRC.rglob("*.md") if p.name != "index.md"]
    for p in files:
        render_file(p)
        print("rendered", p.relative_to(ROOT))
    print("done", len(files), "articles")


if __name__ == "__main__":
    main()
