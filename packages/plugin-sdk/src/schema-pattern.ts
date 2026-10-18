const MAX_PATTERN_LENGTH = 256;
const MAX_REPETITION = 4_096;
const CHARACTER_CLASS_ESCAPES = new Set(['d', 'D', 's', 'S', 'w', 'W']);
const ESCAPED_SYNTAX = new Set(['\\', '.', '^', '$', '*', '+', '?', '{', '}', '[', ']', '(', ')', '|', '/']);
const CONTROL_ESCAPES = new Map<string, number>([
  ['0', 0], ['b', 8], ['f', 12], ['n', 10], ['r', 13], ['t', 9], ['v', 11],
]);

interface ParsedAtom {
  next: number;
  rangeable: boolean;
  codePoint?: number;
  literalAlternatives?: boolean;
}

interface ParsedQuantifier {
  next: number;
  variable: boolean;
}

function codePointAt(pattern: string, index: number): { value: number; next: number } {
  const value = pattern.codePointAt(index);
  if (value === undefined) return { value: -1, next: index };
  return { value, next: index + (value > 0xffff ? 2 : 1) };
}

function isDigit(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x39;
}

function hexValue(codePoint: number): number {
  if (codePoint >= 0x30 && codePoint <= 0x39) return codePoint - 0x30;
  if (codePoint >= 0x41 && codePoint <= 0x46) return codePoint - 0x41 + 10;
  if (codePoint >= 0x61 && codePoint <= 0x66) return codePoint - 0x61 + 10;
  return -1;
}

function readFixedHex(pattern: string, start: number, end: number, digits: number): { value: number; next: number } | null {
  if (start + digits > end) return null;
  let value = 0;
  for (let index = start; index < start + digits; index += 1) {
    const digit = hexValue(pattern.charCodeAt(index));
    if (digit < 0) return null;
    value = value * 16 + digit;
  }
  return { value, next: start + digits };
}

function readUnicodeEscape(pattern: string, index: number, end: number): { value: number; next: number } | null {
  if (pattern[index + 2] !== '{') {
    const result = readFixedHex(pattern, index + 2, end, 4);
    if (!result || result.value >= 0xd800 && result.value <= 0xdfff) return null;
    return result;
  }

  let cursor = index + 3;
  let value = 0;
  let digits = 0;
  while (cursor < end && pattern.charCodeAt(cursor) !== 0x7d) {
    const digit = hexValue(pattern.charCodeAt(cursor));
    if (digit < 0 || digits >= 6) return null;
    value = value * 16 + digit;
    digits += 1;
    cursor += 1;
  }
  if (digits === 0 || cursor >= end || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) return null;
  return { value, next: cursor + 1 };
}

function readEscape(pattern: string, index: number, end: number, inClass: boolean): ParsedAtom | null {
  const escapeIndex = index + 1;
  if (escapeIndex >= end) return null;
  const escaped = pattern[escapeIndex];
  if (escaped === undefined) return null;
  const codePoint = escaped.codePointAt(0);
  if (codePoint === undefined) return null;

  if (CHARACTER_CLASS_ESCAPES.has(escaped)) return { next: escapeIndex + 1, rangeable: false };

  if (escaped === 'x') {
    const result = readFixedHex(pattern, escapeIndex + 1, end, 2);
    return result ? { next: result.next, rangeable: true, codePoint: result.value } : null;
  }
  if (escaped === 'u') {
    const result = readUnicodeEscape(pattern, index, end);
    return result ? { next: result.next, rangeable: true, codePoint: result.value } : null;
  }

  const controlCodePoint = CONTROL_ESCAPES.get(escaped);
  if (controlCodePoint !== undefined) {
    if (escaped === 'b' && !inClass) return null;
    if (escaped === '0' && isDigit(pattern.charCodeAt(escapeIndex + 1) || -1)) return null;
    return { next: escapeIndex + 1, rangeable: true, codePoint: controlCodePoint };
  }

  if (ESCAPED_SYNTAX.has(escaped) || inClass && escaped === '-') {
    return { next: escapeIndex + 1, rangeable: true, codePoint };
  }
  return null;
}

function readCharacterClass(pattern: string, index: number, end: number): ParsedAtom | null {
  let cursor = index + 1;
  if (pattern[cursor] === '^') cursor += 1;
  const contentStart = cursor;
  const tokens: ({ kind: 'dash' } | { kind: 'atom'; rangeable: boolean; codePoint?: number })[] = [];
  let closed = false;

  while (cursor < end) {
    const current = pattern[cursor];
    if (current === ']') {
      cursor += 1;
      closed = true;
      break;
    }
    if (current === '[') return null;
    if (current === '\\') {
      const escaped = readEscape(pattern, cursor, end, true);
      if (!escaped) return null;
      tokens.push({ kind: 'atom', rangeable: escaped.rangeable, ...(escaped.codePoint === undefined ? {} : { codePoint: escaped.codePoint }) });
      cursor = escaped.next;
      continue;
    }

    const point = codePointAt(pattern, cursor);
    if (current === '-' && cursor > contentStart && pattern[cursor + 1] !== ']') {
      tokens.push({ kind: 'dash' });
    } else {
      tokens.push({ kind: 'atom', rangeable: true, codePoint: point.value });
    }
    cursor = point.next;
  }

  if (!closed || tokens.length === 0) return null;
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (token?.kind !== 'dash') continue;
    const previous = tokens[tokenIndex - 1];
    const next = tokens[tokenIndex + 1];
    if (previous?.kind !== 'atom' || next?.kind !== 'atom' || !previous.rangeable || !next.rangeable || previous.codePoint === undefined || next.codePoint === undefined || previous.codePoint > next.codePoint) return null;
  }
  return { next: cursor, rangeable: false };
}

function readAtom(pattern: string, index: number, end: number): ParsedAtom | null {
  const current = pattern[index];
  if (current === undefined) return null;
  if (current === '[') return readCharacterClass(pattern, index, end);
  if (current === '\\') return readEscape(pattern, index, end, false);
  if (current === '(') {
    const closing = pattern.indexOf(')', index + 1);
    if (closing < 0 || closing >= end) return null;
    const alternatives = pattern.slice(index + 1, closing).split('|');
    // One unquantified choice among fixed literals has a bounded branch factor.
    // This preserves the existing knowledge ID contract without admitting
    // nested/quantified groups or general regex alternation.
    if (alternatives.length < 2 || alternatives.length > 8 || alternatives.some(value => !/^[A-Za-z0-9_-]{1,32}$/u.test(value))) return null;
    return { next: closing + 1, rangeable: false, literalAlternatives: true };
  }

  const point = codePointAt(pattern, index);
  if ('^$.*+?{}[]()|'.includes(current)) return null;
  return { next: point.next, rangeable: true, codePoint: point.value };
}

function readBound(pattern: string, index: number, end: number): { value: number; next: number } | null {
  let cursor = index;
  let value = 0;
  let digits = 0;
  while (cursor < end) {
    const current = pattern.charCodeAt(cursor);
    if (!isDigit(current)) break;
    value = value * 10 + current - 0x30;
    if (value > MAX_REPETITION) return null;
    digits += 1;
    cursor += 1;
  }
  return digits ? { value, next: cursor } : null;
}

function readQuantifier(pattern: string, index: number, end: number): ParsedQuantifier | null | undefined {
  const current = pattern[index];
  if (current === '*' || current === '+' || current === '?') return { next: index + 1, variable: true };
  if (current !== '{') return undefined;

  const minimum = readBound(pattern, index + 1, end);
  if (!minimum) return null;
  if (pattern[minimum.next] === '}') return { next: minimum.next + 1, variable: false };
  if (pattern[minimum.next] !== ',') return null;
  const maximum = readBound(pattern, minimum.next + 1, end);
  if (!maximum || pattern[maximum.next] !== '}' || maximum.value < minimum.value) return null;
  return { next: maximum.next + 1, variable: maximum.value !== minimum.value };
}

function hasSafePatternGrammar(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH || !pattern.startsWith('^') || !pattern.endsWith('$')) return false;
  const end = pattern.length - 1;
  let cursor = 1;
  let variableRepetitions = 0;
  let literalChoices = 0;

  while (cursor < end) {
    const atom = readAtom(pattern, cursor, end);
    if (!atom || atom.next <= cursor) return false;
    if (atom.literalAlternatives && ++literalChoices > 1) return false;
    cursor = atom.next;

    const quantifier = readQuantifier(pattern, cursor, end);
    if (quantifier === null) return false;
    if (atom.literalAlternatives && quantifier) return false;
    if (quantifier) {
      if (quantifier.variable) variableRepetitions += 1;
      if (variableRepetitions > 1) return false;
      cursor = quantifier.next;
    }
  }
  return cursor === end;
}

/** Returns true only for the bounded, linear-time pattern subset accepted by HASI. */
export function isSafeJsonSchemaPattern(value: unknown): value is string {
  if (typeof value !== 'string' || !hasSafePatternGrammar(value)) return false;
  try {
    new RegExp(value, 'u');
    return true;
  } catch {
    return false;
  }
}

/** Compiles a pattern only after it passes the HASI subset parser. */
export function compileSafeJsonSchemaPattern(value: unknown): RegExp | undefined {
  if (typeof value !== 'string' || !hasSafePatternGrammar(value)) return undefined;
  try {
    return new RegExp(value, 'u');
  } catch {
    return undefined;
  }
}

export function testSafeJsonSchemaPattern(pattern: unknown, value: string): boolean {
  return compileSafeJsonSchemaPattern(pattern)?.test(value) ?? false;
}
