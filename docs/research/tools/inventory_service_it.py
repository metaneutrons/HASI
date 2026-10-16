#!/usr/bin/env python3
"""Inventory publicly linked Service-IT HTML without cookies or authentication.

This is a research inventory, not a production knowledge ingestion pipeline.
Only links discovered on the site are followed. Authentication, query-driven
pages, downloads and external sites are excluded. No source text is persisted.
"""

import argparse
import csv
import hashlib
import json
import re
import time
from collections import deque
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ORIGIN = "https://service.it.hs-hannover.de"
HOST = urlsplit(ORIGIN).netloc


class ScopeRedirect(Exception):
    def __init__(self, destination, status, reason):
        self.destination = urlunsplit((*urlsplit(destination)[:3], "", ""))
        self.status = status
        self.reason = reason


class PublicRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        reason = exclusion(newurl)
        if reason:
            raise ScopeRedirect(newurl, code, reason)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = []
        self.text = []
        self.links = []
        self.language = None
        self.in_title = False
        self.skip = 0
        self.anchor = None
        self.in_main = False
        self.main_text = []
        self.images = []
        self.main_images = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "html":
            self.language = attrs.get("lang")
        if tag in ("script", "style"):
            self.skip += 1
        if tag == "title":
            self.in_title = True
        if tag == "main":
            self.in_main = True
        if tag == "img" and attrs.get("src"):
            value = {"src": attrs["src"], "alt": attrs.get("alt", "")}
            self.images.append(value)
            if self.in_main:
                self.main_images.append(value)
        if tag == "a" and attrs.get("href"):
            self.anchor = [attrs["href"], []]

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        if tag == "title":
            self.in_title = False
        if tag == "main":
            self.in_main = False
        if tag == "a" and self.anchor:
            self.links.append((self.anchor[0], " ".join(self.anchor[1])))
            self.anchor = None

    def handle_data(self, data):
        value = " ".join(data.split())
        if self.skip or not value:
            return
        self.text.append(value)
        if self.in_main:
            self.main_text.append(value)
        if self.in_title:
            self.title.append(value)
        if self.anchor:
            self.anchor[1].append(value)


def normalize(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https"):
        return None
    return urlunsplit((parsed.scheme, parsed.netloc.lower(), parsed.path or "/", parsed.query, ""))


def exclusion(url):
    p = urlsplit(url)
    if p.netloc != HOST:
        return "external"
    if p.query:
        return "query"
    if any(part in ("login", "logout", "admin", "accounts", "search", "suche") for part in p.path.strip("/").split("/")):
        return "authentication-or-dynamic"
    if p.path.startswith(("/static/", "/media/")) or re.search(r"\.(pdf|png|jpe?g|gif|svg|zip|docx?|xlsx?|mp4|css|js|exe|msi|dmg)$", p.path, re.I):
        return "asset-or-download"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--max-pages", type=int, default=500)
    args = ap.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    queue = deque([ORIGIN + "/de/", ORIGIN + "/en/"])
    opener = build_opener(PublicRedirectHandler())
    seen = set(queue)
    pages = []
    discovered = {}
    while queue and len(pages) < args.max_pages:
        url = queue.popleft()
        record = {"url": url}
        try:
            request = Request(url, headers={"User-Agent": "hasi-public-research/0.1"})
            with opener.open(request, timeout=20) as response:
                record.update(status=response.status, final_url=response.url,
                              content_type=response.headers.get("Content-Type", ""),
                              content_language=response.headers.get("Content-Language"))
                if "text/html" not in record["content_type"]:
                    record["classification"] = "non-html"
                    pages.append(record)
                    continue
                raw = response.read(4_000_000)
            parser = PageParser()
            parser.feed(raw.decode("utf-8", errors="replace"))
            text = " ".join(parser.text)
            restricted = any(s in text.lower() for s in (
                "eingeschränkten zugriff", "eingeschränkter zugriff",
                "limited access", "restricted access", "please log in",
                "bitte melden sie sich an"))
            changed = re.search(r"(?:Letzte Änderung|Last (?:modified|change|updated))\s*:?\s*(\d{1,2}\.\s+\w+\s+\d{4}|\w+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})", text)
            record.update(title=" ".join(parser.title), language=parser.language,
                          classification="public-html-with-access-notice" if restricted else "public-html",
                          access_notice=restricted, source_sha256=hashlib.sha256(raw).hexdigest(),
                          last_change_text=changed.group(1).strip() if changed else None,
                          visible_text_characters=len(text), links=[])
            for href, label in parser.links:
                target = normalize(urljoin(record["final_url"], href))
                if not target:
                    continue
                reason = exclusion(target)
                # Keep query URLs out of persisted evidence; they may be login state.
                safe_target = target if not urlsplit(target).query else urlunsplit((*urlsplit(target)[:3], "", ""))
                record["links"].append({"url": safe_target, "label": label, "exclusion": reason})
                discovered.setdefault(safe_target, {"label": label, "exclusion": reason, "from": url})
                if not reason and target not in seen:
                    seen.add(target)
                    queue.append(target)
        except ScopeRedirect as error:
            record.update(status=error.status, classification="redirect-out-of-public-scope",
                          redirect_destination=error.destination, redirect_reason=error.reason)
        except HTTPError as error:
            record.update(status=error.code, classification="http-error")
        except (URLError, TimeoutError, OSError) as error:
            record.update(classification="fetch-error", error=type(error).__name__)
        pages.append(record)
        if len(pages) % 25 == 0:
            print(f"Fetched {len(pages)} pages; {len(queue)} pending", flush=True)
        time.sleep(0.12)
    result = {"snapshot_date": "2026-10-09", "scope": "Anonymous linked public HTML only",
              "complete_within_discovered_scope": not queue,
              "remaining_queue": list(queue), "pages": pages,
              "discovered_links": discovered}
    (args.output / "inventory.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    columns = ["url", "status", "classification", "language", "title", "access_notice", "last_change_text", "source_sha256"]
    with (args.output / "inventory.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(pages)
    counts = {}
    for page in pages:
        key = page["classification"]
        counts[key] = counts.get(key, 0) + 1
    print(json.dumps({"pages": len(pages), "pending": len(queue), "classifications": counts}))


if __name__ == "__main__":
    main()
