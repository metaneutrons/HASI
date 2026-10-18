import { html as parse5Html, parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5';

export interface HtmlExtraction {
  title: string;
  text: string;
  language?: 'de' | 'en';
  sourceUpdatedAt?: string;
  images: { alt: string; sourceUrl: string | null }[];
  links: string[];
}

export interface HtmlExtractionOptions {
  container?: { kind: 'id' | 'tag' | 'class'; value: string };
  fragment?: boolean;
}

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 200_000;
const MAX_TITLE_CHARACTERS = 200;
const MAX_IMAGES = 200;
const MAX_LINKS = 2_000;
const EXTRACTION_ERROR = 'Content HTML extraction failed';

const REMOVED_TAGS = new Set([
  'nav', 'header', 'footer', 'script', 'style', 'form', 'template', 'iframe',
  'object', 'svg', 'canvas', 'noscript',
]);

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'li', 'main', 'menu', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);

type HtmlNode = DefaultTreeAdapterMap['node'];
type HtmlParent = DefaultTreeAdapterMap['parentNode'];
type HtmlElement = DefaultTreeAdapterMap['element'];
type HtmlTextNode = DefaultTreeAdapterMap['textNode'];

export function extractContentHtml(html: string, options: HtmlExtractionOptions = {}): HtmlExtraction {
  try {
    if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      fail();
    }
    if (!isOptions(options)) fail();

    const isFragment = options.fragment === true;
    const document = isFragment ? parseFragment(html) : parse(html);

    if (containsLoginForm(document)) fail();

    const title = isFragment ? '' : readDocumentTitle(document);
    if (characterCount(title) > MAX_TITLE_CHARACTERS) fail();

    const contentRoot = selectContentRoot(document, options, isFragment);
    const images: HtmlExtraction['images'] = [];
    const links: string[] = [];
    const text = extractReadableText(contentRoot, images, links);

    if (characterCount(text) > MAX_TEXT_CHARACTERS || images.length > MAX_IMAGES || links.length > MAX_LINKS) {
      fail();
    }

    const result: HtmlExtraction = { title, text, images, links };
    const language = readLanguage(document);
    const sourceUpdatedAt = readSourceUpdatedAt(document);
    if (language !== undefined) result.language = language;
    if (sourceUpdatedAt !== undefined) result.sourceUpdatedAt = sourceUpdatedAt;
    return result;
  } catch {
    throw new Error(EXTRACTION_ERROR);
  }
}

function isOptions(value: unknown): value is HtmlExtractionOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  if (options.fragment !== undefined && typeof options.fragment !== 'boolean') return false;
  if (options.container === undefined) return true;
  if (typeof options.container !== 'object' || options.container === null || Array.isArray(options.container)) return false;
  const container = options.container as Record<string, unknown>;
  return (container.kind === 'id' || container.kind === 'tag' || container.kind === 'class')
    && typeof container.value === 'string'
    && container.value.trim().length > 0;
}

function selectContentRoot(document: HtmlParent, options: HtmlExtractionOptions, isFragment: boolean): HtmlParent {
  if (isFragment && options.container === undefined) return document;

  if (options.container !== undefined) {
    const allElements = findElements(document);
    const container = options.container;
    const matching = allElements.filter((element) => matchesContainer(element, container));
    if (matching.length !== 1) fail();
    const match = matching[0];
    if (match === undefined || !isEligibleContainer(match)) fail();
    return match;
  }

  const candidates = findVisibleElements(document);
  const mains = candidates.filter((element) => element.tagName === 'main');
  if (mains.length === 1) {
    const main = mains[0];
    if (main === undefined) fail();
    return main;
  }
  if (mains.length > 1) fail();

  const articles = candidates.filter((element) => element.tagName === 'article');
  if (articles.length !== 1) fail();
  const article = articles[0];
  if (article === undefined) fail();
  return article;
}

function matchesContainer(element: HtmlElement, container: NonNullable<HtmlExtractionOptions['container']>): boolean {
  switch (container.kind) {
    case 'id':
      return getAttribute(element, 'id') === container.value;
    case 'tag':
      return element.tagName === container.value.toLowerCase();
    case 'class':
      return (getAttribute(element, 'class') ?? '').split(/\s+/u).includes(container.value);
  }
}

function findVisibleElements(root: HtmlParent): HtmlElement[] {
  const result: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if (!isElement(node)) return;
    if (node.namespaceURI !== parse5Html.NS.HTML || isPruned(node)) return;
    result.push(node);
    for (const child of node.childNodes) visit(child);
  };
  for (const child of root.childNodes) visit(child);
  return result;
}

function containsLoginForm(root: HtmlParent): boolean {
  let found = false;
  const visit = (node: HtmlNode): void => {
    if (found || !isElement(node)) return;
    if (node.tagName === 'form') {
      const action = getAttribute(node, 'action') ?? '';
      if (/login|saml|sso|oauth/iu.test(action) || containsPasswordInput(node)) {
        found = true;
        return;
      }
    }
    for (const child of node.childNodes) visit(child);
    if (node.tagName === 'template' && 'content' in node) {
      for (const child of node.content.childNodes) visit(child);
    }
  };
  for (const child of root.childNodes) visit(child);
  return found;
}

function containsPasswordInput(form: HtmlElement): boolean {
  let found = false;
  const visit = (node: HtmlNode): void => {
    if (found || !isElement(node)) return;
    if (node.tagName === 'input' && (getAttribute(node, 'type') ?? '').toLowerCase() === 'password') {
      found = true;
      return;
    }
    for (const child of node.childNodes) visit(child);
    if (node.tagName === 'template' && 'content' in node) {
      for (const child of node.content.childNodes) visit(child);
    }
  };
  for (const child of form.childNodes) visit(child);
  return found;
}

function readDocumentTitle(document: HtmlParent): string {
  const titleElement = findElements(document).find((element) => element.tagName === 'title');
  if (titleElement === undefined) fail();
  const title = cleanText(readAllText(titleElement)).trim();
  if (title.length === 0) fail();
  return title;
}

function readLanguage(document: HtmlParent): 'de' | 'en' | undefined {
  const htmlElement = findElements(document).find((element) => element.tagName === 'html');
  const language = cleanAttribute(htmlElement === undefined ? undefined : getAttribute(htmlElement, 'lang')).toLowerCase();
  if (/^de(?:-|$)/u.test(language)) return 'de';
  if (/^en(?:-|$)/u.test(language)) return 'en';
  return undefined;
}

function readSourceUpdatedAt(document: HtmlParent): string | undefined {
  for (const element of findElements(document)) {
    if ((getAttribute(element, 'property') ?? '').trim().toLowerCase() !== 'article:modified_time') continue;
    const value = (getAttribute(element, 'content') ?? '').trim();
    if (isValidIsoTimestamp(value)) return value;
  }
  return undefined;
}

function isValidIsoTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/iu.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = value.endsWith('Z') || value.endsWith('z') ? undefined : /[+-](\d{2}):(\d{2})$/u.exec(value);
  const maximumDay = daysInMonth[month - 1];
  if (month < 1 || month > 12 || maximumDay === undefined || day < 1 || day > maximumDay) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== null && zone !== undefined && (Number(zone[1]) > 23 || Number(zone[2]) > 59)) return false;
  return true;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function extractReadableText(root: HtmlParent, images: HtmlExtraction['images'], links: string[]): string {
  let output = '';
  const appendText = (value: string): void => {
    const normalized = cleanText(value);
    if (normalized.length > 0) output += normalized;
  };
  const boundary = (): void => {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n';
  };

  const visit = (node: HtmlNode): void => {
    if (isTextNode(node)) {
      appendText(node.value);
      return;
    }
    if (!isElement(node) || node.namespaceURI !== parse5Html.NS.HTML || isPruned(node)) return;

    const tag = node.tagName;
    if (tag === 'img') {
      if (images.length >= MAX_IMAGES) fail();
      const alt = cleanText(getAttribute(node, 'alt') ?? '');
      const source = cleanAttribute(getAttribute(node, 'src'));
      images.push({ alt, sourceUrl: source.length === 0 ? null : source });
      return;
    }
    if (tag === 'a') {
      const href = cleanAttribute(getAttribute(node, 'href'));
      if (href.length > 0) {
        if (links.length >= MAX_LINKS) fail();
        links.push(href);
      }
    }
    if (tag === 'br' || tag === 'hr') {
      boundary();
      return;
    }
    if (tag === 'tr') {
      boundary();
      let hasCell = false;
      for (const child of node.childNodes) {
        if (isElement(child) && (child.tagName === 'td' || child.tagName === 'th')) {
          if (hasCell) output += ' | ';
          hasCell = true;
        }
        visit(child);
      }
      boundary();
      return;
    }

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) boundary();
    if (tag === 'li') appendText('- ');
    for (const child of node.childNodes) visit(child);
    if (isBlock) boundary();
  };

  for (const child of root.childNodes) visit(child);
  const text = output.split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return text;
}

function findElements(root: HtmlParent): HtmlElement[] {
  const result: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if (!isElement(node)) return;
    result.push(node);
    for (const child of node.childNodes) visit(child);
  };
  for (const child of root.childNodes) visit(child);
  return result;
}

function isEligibleContainer(element: HtmlElement): boolean {
  let current: HtmlParent | null = element;
  while (current !== null && 'tagName' in current) {
    if (current.namespaceURI !== parse5Html.NS.HTML || isPruned(current)) return false;
    current = current.parentNode;
  }
  return true;
}

function readAllText(root: HtmlParent): string {
  let text = '';
  const visit = (node: HtmlNode): void => {
    if (isTextNode(node)) {
      text += node.value;
      return;
    }
    if (!isElement(node)) return;
    for (const child of node.childNodes) visit(child);
    if (node.tagName === 'template' && 'content' in node) {
      for (const child of node.content.childNodes) visit(child);
    }
  };
  for (const child of root.childNodes) visit(child);
  return text;
}

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node;
}

function isTextNode(node: HtmlNode): node is HtmlTextNode {
  return node.nodeName === '#text';
}

function isPruned(element: HtmlElement): boolean {
  if (REMOVED_TAGS.has(element.tagName)) return true;
  if (getAttribute(element, 'hidden') !== undefined) return true;
  if ((getAttribute(element, 'aria-hidden') ?? '').trim().toLowerCase() === 'true') return true;
  return hasHiddenInlineStyle(getAttribute(element, 'style') ?? '');
}

function hasHiddenInlineStyle(style: string): boolean {
  return style.split(';').some((declaration) => {
    const separator = declaration.indexOf(':');
    if (separator < 0) return false;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).replace(/\s*!important\s*$/iu, '').trim().toLowerCase();
    return (property === 'display' && value === 'none')
      || (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
      || (property === 'content-visibility' && value === 'hidden');
  });
}

function getAttribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name.toLowerCase())?.value;
}

function cleanText(value: string): string {
  return stripControls(value, true).replace(/\s+/gu, ' ');
}

function cleanAttribute(value: string | undefined): string {
  return stripControls(value ?? '', false).trim();
}

function stripControls(value: string, preserveWhitespace: boolean): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    if (!isControl || (preserveWhitespace && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d))) {
      result += character;
    }
  }
  return result;
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function fail(): never {
  throw new Error(EXTRACTION_ERROR);
}
