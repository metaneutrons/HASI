#!/usr/bin/env python3
"""Capture the verified anonymous HTML inventory as a research text corpus.

Retains public content only, with source provenance and image references.
Text extraction is a preliminary research extractor, not an accepted RAG feed.
"""

import argparse
import hashlib
import json
import time
from urllib.parse import urljoin
from urllib.request import Request, build_opener

from inventory_service_it import PageParser, PublicRedirectHandler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inventory", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    with open(args.inventory) as handle:
        inventory = json.load(handle)
    pages = {p["final_url"]: p for p in inventory["pages"]
             if p["classification"].startswith("public-html")}
    opener = build_opener(PublicRedirectHandler())
    captured = 0
    errors = []
    with open(args.output, "w") as out:
        for url, page in sorted(pages.items()):
            try:
                with opener.open(Request(url, headers={"User-Agent": "hasi-public-research/0.1"}), timeout=20) as response:
                    raw = response.read(4_000_000)
                parser = PageParser()
                parser.feed(raw.decode("utf-8", errors="replace"))
                images = parser.main_images if parser.main_text else parser.images
                images = [dict(image, src=urljoin(url, image["src"])) for image in images]
                record = {"url": url, "title": page["title"], "language": page["language"],
                          "snapshot_date": inventory["snapshot_date"], "access": "anonymous-public",
                          "source_sha256": hashlib.sha256(raw).hexdigest(),
                          "source_last_change": page.get("last_change_text"),
                          "extraction": "main-text" if parser.main_text else "whole-page-text-needs-cleanup",
                          "text_blocks": parser.main_text or parser.text, "image_references": images,
                          "access_notice": page.get("access_notice", False)}
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                captured += 1
            except Exception as error:
                errors.append({"url": url, "error": type(error).__name__})
            if captured % 25 == 0:
                print(f"Captured {captured} public pages", flush=True)
            time.sleep(0.12)
    print(json.dumps({"captured": captured, "errors": errors}))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
