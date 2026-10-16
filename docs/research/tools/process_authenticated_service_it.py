#!/usr/bin/env python3
"""Build local research artifacts from saved authenticated Service-IT HTML.

This processor is intentionally offline. It reads files from the authenticated
capture directory and writes a private corpus, inventory, and FAQ-link index
next to those captures. Visible audience tags are recorded as page labels only;
they are not treated as evidence of authorization policy.
"""

import argparse
import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

ORIGIN = "https://service.it.hs-hannover.de"
SNAPSHOT_DATE = "2026-10-09"
VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}
IGNORED_TAGS = {"script", "style", "noscript", "template", "svg"}
BODY_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "pre", "dt", "dd"}


class Node:
    def __init__(self, tag, attrs=None):
        self.tag = tag
        self.attrs = dict(attrs or ())
        self.children = []
        self.parts = []
        self.parent = None


class TreeParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("document")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag.lower(), attrs)
        node.parent = self.stack[-1]
        node.parent.children.append(node)
        node.parent.parts.append(node)
        if tag.lower() not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].parts.append(data)


def walk(node):
    yield node
    for child in node.children:
        yield from walk(child)


def classes(node):
    return set(node.attrs.get("class", "").split())


def text_content(node):
    if node.tag in IGNORED_TAGS or node.tag in {"input", "select", "textarea", "button"}:
        return ""
    pieces = [text_content(part) if isinstance(part, Node) else part for part in node.parts]
    return " ".join(" ".join(pieces).split())


def scrub_text(value, sensitive_values):
    result = " ".join(value.split())
    for secret in sorted((v for v in sensitive_values if len(v) >= 3), key=len, reverse=True):
        result = re.sub(re.escape(secret), "[REDACTED]", result, flags=re.I)
    result = re.sub(r"(?i)\b(?:csrfmiddlewaretoken|csrf_token|sessionid|session_id|access_token|auth_token)\s*[:=]\s*[^\s,;]+", "[REDACTED]", result)
    return " ".join(result.split())


def safe_url(value, base):
    if not value:
        return None
    absolute = urljoin(base, value.strip())
    parsed = urlsplit(absolute)
    if parsed.scheme not in {"http", "https"}:
        return None
    # Query strings and fragments can contain login state or tracking values.
    return urlunsplit((parsed.scheme, parsed.netloc.lower(), parsed.path or "/", "", ""))


def node_links(node, source_url, sensitive_values):
    links = []
    for item in walk(node):
        if item.tag != "a" or not item.attrs.get("href"):
            continue
        href = safe_url(item.attrs["href"], source_url)
        if href:
            links.append({"url": href, "label": scrub_text(text_content(item), sensitive_values)})
    return links


def node_images(node, source_url, sensitive_values):
    images = []
    for item in walk(node):
        if item.tag != "img":
            continue
        src = safe_url(item.attrs.get("src") or item.attrs.get("data-src"), source_url)
        if src:
            images.append({"src": src, "alt": scrub_text(item.attrs.get("alt", ""), sensitive_values)})
    return images


def filename_url(path):
    stem = path.stem
    if stem == "de-services-catalogue":
        return ORIGIN + "/de/services/"
    if stem.startswith("de-services-"):
        return ORIGIN + "/de/services/" + stem.removeprefix("de-services-") + "/"
    if stem.startswith("de-faqs-"):
        return ORIGIN + "/de/faqs/" + stem.removeprefix("de-faqs-") + "/"
    return None


def source_identity(root, path):
    nodes = list(walk(root))
    canonicals = [n for n in nodes if n.tag == "link" and "canonical" in n.attrs.get("rel", "").lower().split() and n.attrs.get("href")]
    html_node = next((n for n in nodes if n.tag == "html"), None)
    language = (html_node.attrs.get("lang", "") if html_node else "").split("-", 1)[0].lower() or None
    alternates = [n for n in nodes if n.tag == "a" and n.attrs.get("href") and n.attrs.get("hreflang")]
    if not alternates:
        alternates = [n for n in nodes if n.tag == "link" and n.attrs.get("href") and n.attrs.get("hreflang")]
    same_language = next((n for n in alternates if n.attrs.get("hreflang", "").split("-", 1)[0].lower() == language), None)
    selected = canonicals[0] if canonicals else same_language or (alternates[0] if alternates else None)
    if selected:
        return safe_url(selected.attrs.get("href"), ORIGIN), "canonical" if selected in canonicals else "hreflang-link", language
    return filename_url(path), "filename-inference", language


def extract_account_and_secret_values(root, source):
    secrets = set()
    # The displayed account identifier appears in authenticated page chrome.
    account_match = re.search(r"Angemeldet\s+als\s*<strong[^>]*>\s*([^<]+?)\s*</strong", source, re.I)
    if account_match:
        secrets.add(" ".join(account_match.group(1).split()))
    for node in walk(root):
        if node.tag == "input" and (node.attrs.get("type", "").lower() == "hidden" or re.search(r"csrf|token|session", node.attrs.get("name", ""), re.I)):
            value = node.attrs.get("value", "")
            if value:
                secrets.add(value)
        if node.tag == "meta" and re.search(r"csrf|token|session", node.attrs.get("name", "") + node.attrs.get("property", ""), re.I):
            if node.attrs.get("content"):
                secrets.add(node.attrs["content"])
    return secrets


def page_title(root, sensitive_values):
    nodes = list(walk(root))
    hero = next((n for n in nodes if "keyvisual" in classes(n)), None)
    if hero:
        title = next((n for n in walk(hero) if "title" in classes(n)), None)
        if title and text_content(title):
            return scrub_text(text_content(title), sensitive_values)
    title_node = next((n for n in nodes if n.tag == "title"), None)
    if title_node:
        title = scrub_text(text_content(title), sensitive_values)
        return title.split(" | ", 1)[0].strip()
    return path_title_fallback(root, sensitive_values)


def path_title_fallback(root, sensitive_values):
    for node in walk(root):
        if node.tag in {"h1", "h2"} and text_content(node):
            return scrub_text(text_content(node), sensitive_values)
    return None


def audience_labels(main, sensitive_values):
    labels = []
    for node in walk(main):
        if node.tag == "div" and "is-service" in classes(node) and "tag" in classes(node):
            label = scrub_text(text_content(node), sensitive_values)
            if label and label not in labels:
                labels.append(label)
    return labels


def extract_blocks(main, source_url, labels, sensitive_values):
    blocks = []
    articles = [n for n in walk(main) if n.tag == "article"]
    if articles:
        seen_entries = set()
        for index, article in enumerate(articles, 1):
            content = scrub_text(text_content(article), sensitive_values)
            if content:
                title_node = next((n for n in walk(article) if "title" in classes(n)), None)
                title = scrub_text(text_content(title_node), sensitive_values) if title_node else None
                links = node_links(article, source_url, sensitive_values)
                service_url = next((link["url"] for link in links if "/de/services/" in link["url"] and "/category/" not in link["url"]), None)
                entry_key = service_url or title or content
                # The catalogue renders the same cards in separate responsive layouts.
                if entry_key in seen_entries:
                    continue
                seen_entries.add(entry_key)
                blocks.append({
                    "block_index": index,
                    "block_type": "service-catalogue-entry",
                    "heading": title,
                    "service_url": service_url,
                    "text": content,
                    "display_audience_labels": labels,
                    "links": links,
                    "image_references": node_images(article, source_url, sensitive_values),
                })
        return blocks

    content_root = next((n for n in walk(main) if n.tag == "div" and "content" in classes(n)), main)
    keyed = []
    for node in walk(content_root):
        if node is content_root or not node.attrs.get("data-block-key"):
            continue
        ancestor = node.parent
        nested = False
        while ancestor is not None and ancestor is not content_root:
            if ancestor.attrs.get("data-block-key"):
                nested = True
                break
            ancestor = ancestor.parent
        if not nested:
            keyed.append(node)
    candidates = keyed
    if not candidates:
        candidates = []
        for node in walk(content_root):
            if node.tag not in BODY_TAGS or not text_content(node):
                continue
            ancestor = node.parent
            nested = False
            while ancestor is not None and ancestor is not content_root:
                if ancestor.tag in BODY_TAGS:
                    nested = True
                    break
                ancestor = ancestor.parent
            if not nested:
                candidates.append(node)
    for index, node in enumerate(candidates, 1):
        content = scrub_text(text_content(node), sensitive_values)
        if not content:
            continue
        blocks.append({
            "block_index": index,
            "block_type": node.tag,
            "heading": content if node.tag in {"h1", "h2", "h3", "h4", "h5", "h6"} else None,
            "text": content,
            "display_audience_labels": labels,
            "links": node_links(node, source_url, sensitive_values),
            "image_references": node_images(node, source_url, sensitive_values),
        })
    return blocks


def faq_index_entries(root, source_url, path, sensitive_values):
    results = []
    for node in walk(root):
        if node.tag != "a" or not node.attrs.get("href"):
            continue
        url = safe_url(node.attrs["href"], source_url)
        if url and re.search(r"/de/faqs/", url):
            results.append({"url": url, "label": scrub_text(text_content(node), sensitive_values), "discovered_from": path.name})
    return results


def selected_role_context(root):
    role_select = next((n for n in walk(root) if n.tag == "select" and n.attrs.get("id") == "role"), None)
    if not role_select:
        return {"selected_group": None, "available_groups": []}
    selected = None
    available = []
    for option in walk(role_select):
        if option.tag != "option":
            continue
        label = " ".join(text_content(option).split())
        if label and label not in available:
            available.append(label)
        if "selected" in option.attrs:
            selected = label
    return {"selected_group": selected, "available_groups": available}


def process_file(path):
    raw = path.read_bytes()
    source = raw.decode("utf-8", errors="replace")
    parser = TreeParser()
    parser.feed(source)
    root = parser.root
    source_url, source_basis, language = source_identity(root, path)
    sensitive_values = extract_account_and_secret_values(root, source)
    # The filename fallback is always a safe first-party identity if metadata is absent.
    source_url = source_url or filename_url(path) or ORIGIN + "/"
    main = next((n for n in walk(root) if n.tag == "main"), None)
    labels = audience_labels(main, sensitive_values) if main else []
    blocks = extract_blocks(main, source_url, labels, sensitive_values) if main else []
    title = page_title(root, sensitive_values)
    faq_entries = faq_index_entries(root, source_url, path, sensitive_values)
    role = selected_role_context(root)
    # Keep page-level <img> references too: current captures mostly expose the
    # shared site logo outside <main>, while block references remain scoped to
    # their content blocks above.
    image_refs = node_images(root, source_url, sensitive_values)
    corpus_record = {
        "source_url": source_url,
        "source_url_basis": source_basis,
        "title": title,
        "language": language,
        "snapshot_date": SNAPSHOT_DATE,
        "access_context": "authenticated-capture",
        "visible_audience_labels": labels,
        "audience_interpretation": "display-labels-only; authorization policy is not inferred",
        "text_blocks": blocks,
        "image_references": image_refs,
    }
    inventory_record = {
        "file": path.name,
        "source_url": source_url,
        "source_url_basis": source_basis,
        "title": title,
        "language": language,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "file_bytes": len(raw),
        "text_block_count": len(blocks),
        "catalogue_service_count": sum(block["block_type"] == "service-catalogue-entry" for block in blocks),
        "image_reference_count": len(image_refs),
        "faq_link_count": len(faq_entries),
        "visible_audience_labels": labels,
        "audience_interpretation": "display-labels-only; authorization policy is not inferred",
        "selected_group_in_capture": role["selected_group"],
        "available_groups_in_capture": role["available_groups"],
    }
    return corpus_record, inventory_record, faq_entries


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--captures", type=Path, default=Path(__file__).resolve().parents[1] / "service-it" / "authenticated")
    ap.add_argument("--output-dir", type=Path, help="Defaults to --captures")
    args = ap.parse_args()
    output_dir = args.output_dir or args.captures
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = sorted(args.captures.glob("*.html"))
    corpus = []
    inventory = []
    seen_documents = set()
    faq_by_url = {}
    errors = []
    for path in paths:
        try:
            record, item, faq_entries = process_file(path)
            signature = (item["source_url"], item["sha256"])
            if signature not in seen_documents:
                corpus.append(record)
                seen_documents.add(signature)
            inventory.append(item)
            for entry in faq_entries:
                previous = faq_by_url.setdefault(entry["url"], {"url": entry["url"], "labels": [], "discovered_from": []})
                if entry["label"] and entry["label"] not in previous["labels"]:
                    previous["labels"].append(entry["label"])
                if entry["discovered_from"] not in previous["discovered_from"]:
                    previous["discovered_from"].append(entry["discovered_from"])
        except Exception as error:  # Keep a useful inventory even if one capture is malformed.
            errors.append({"file": path.name, "error": type(error).__name__})
    inventory_document = {
        "snapshot_date": SNAPSHOT_DATE,
        "processing_mode": "offline; saved HTML only",
        "scope": "Authenticated Service-IT captures supplied in the local capture directory",
        "group_context_note": "Selected and available groups describe this capture session only; they do not establish complete rights.",
        "capture_count": len(paths),
        "processed_count": len(inventory),
        "corpus_document_count": len(corpus),
        "errors": errors,
        "captures": inventory,
    }
    faq_document = {
        "snapshot_date": SNAPSHOT_DATE,
        "processing_mode": "offline; links extracted from saved HTML",
        "faq_count": len(faq_by_url),
        "faqs": sorted(faq_by_url.values(), key=lambda item: item["url"]),
    }
    (output_dir / "authenticated-corpus.jsonl").write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in corpus), encoding="utf-8")
    (output_dir / "authenticated-inventory.json").write_text(json.dumps(inventory_document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (output_dir / "authenticated-faq-index.json").write_text(json.dumps(faq_document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"captures": len(paths), "processed_captures": len(inventory), "corpus_documents": len(corpus), "errors": errors,
                      "unique_source_urls": len({r['source_url'] for r in corpus}),
                      "faq_urls": len(faq_by_url),
                      "output_files": ["authenticated-corpus.jsonl", "authenticated-inventory.json", "authenticated-faq-index.json"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
