import { jsonrepair } from 'jsonrepair'

/** Options for {@link extractJsonCandidates}. */
export interface ExtractOptions {
  /** Also try the first `<tag>…</tag>` region, right after the fences. A plain identifier. */
  tag?: string
  /** The fence info strings whose bodies are tried, compared trimmed and lowercase. */
  fenceLanguages?: readonly string[]
  /**
   * How many brackets that never balance the scan tries, per bracket type, before it stops.
   * Each one reads to the end of the text.
   */
  maxUnbalancedStarts?: number
}

/** The defaults of {@link ExtractOptions}. */
export const EXTRACT_DEFAULTS = Object.freeze({
  fenceLanguages: Object.freeze(['', 'json', 'jsonc']) as readonly string[],
  maxUnbalancedStarts: 64,
})

/** {@link ExtractOptions} with the defaults applied and checked. */
export interface ResolvedExtractOptions {
  tagPattern: RegExp | null
  fenceLanguages: ReadonlySet<string>
  maxUnbalancedStarts: number
}

const SAFE_TAG = /^[a-z][a-z0-9_]*$/i

/** Apply the defaults and check the ranges. Throws a `RangeError` naming the bad option. */
export function resolveExtractOptions(o: ExtractOptions = {}): ResolvedExtractOptions {
  const max = o.maxUnbalancedStarts ?? EXTRACT_DEFAULTS.maxUnbalancedStarts
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`maxUnbalancedStarts must be an integer >= 1, got ${String(max)}`)
  }
  if (o.tag !== undefined && !SAFE_TAG.test(o.tag)) {
    throw new RangeError(`tag must match ${String(SAFE_TAG)}, got ${JSON.stringify(o.tag)}`)
  }
  const languages = o.fenceLanguages ?? EXTRACT_DEFAULTS.fenceLanguages
  return {
    tagPattern: o.tag === undefined ? null : new RegExp(`<${o.tag}>([\\s\\S]*?)</${o.tag}>`, 'i'),
    fenceLanguages: new Set(languages.map((l) => l.trim().toLowerCase())),
    maxUnbalancedStarts: max,
  }
}

/** jsonrepair + JSON.parse over one slice; unwraps a double-encoded JSON string. Null on failure. */
function repairParse(slice: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(jsonrepair(slice))
    const unwrapped = typeof parsed === 'string' ? (JSON.parse(parsed) as unknown) : parsed
    return unwrapped !== null && typeof unwrapped === 'object' ? unwrapped : (unwrapped ?? null)
  } catch {
    return null
  }
}

/**
 * Bodies of the fenced blocks whose info string is in `languages`, in order. A body ends at the
 * nearest ```, and the scan resumes there. When the body's JSON value balances past that ```
 * (a ``` inside a JSON string), the whole value comes first.
 */
function* fenceBodies(text: string, languages: ReadonlySet<string>): Generator<string> {
  const opener = /```([^\n]*)\n/g
  for (let m = opener.exec(text); m !== null; m = opener.exec(text)) {
    const start = m.index + m[0].length
    const end = text.indexOf('```', start)
    if (end === -1) return
    if (languages.has(m[1].trim().toLowerCase())) {
      const whole = valueEnd(text, start)
      if (whole > end) yield text.slice(start, whole).trim()
      yield text.slice(start, end).trim()
    }
    opener.lastIndex = end + 3
  }
}

/** Index of the ``` after the balanced end of the `{` or `[` value at `start`, or -1. */
function valueEnd(text: string, start: number): number {
  let i = start
  while (i < text.length && /\s/.test(text[i])) i++
  const open = text[i]
  if (open !== '{' && open !== '[') return -1
  const close = balancedEnd(text, i, open, open === '{' ? '}' : ']')
  return close === -1 ? -1 : text.indexOf('```', close + 1)
}

/** Index of the `close` that balances the `open` at `start`, or -1. Braces in strings do not count. */
function balancedEnd(text: string, start: number, open: string, close: string): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The value of a JSON text that stops right after a complete value, once its missing closing
 * brackets are added. `undefined` when the text parses as it is, ends inside a string, or still
 * fails to parse.
 */
export function closeMissingBrackets(text: string): unknown {
  try {
    JSON.parse(text)
    return undefined
  } catch {
    // Not valid as it is: find the brackets it leaves open.
  }
  const closers: string[] = []
  let inStr = false
  let esc = false
  for (const ch of text) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') closers.push('}')
    else if (ch === '[') closers.push(']')
    else if ((ch === '}' || ch === ']') && closers.pop() !== ch) return undefined
  }
  if (inStr || closers.length === 0) return undefined
  try {
    return JSON.parse(text + closers.reverse().join('')) as unknown
  } catch {
    return undefined
  }
}

/** Every top-level balanced open…close slice, left to right. */
function* balancedSlices(
  text: string,
  open: '{' | '[',
  close: '}' | ']',
  maxUnbalanced: number,
): Generator<string> {
  let from = 0
  let unbalanced = 0
  while (unbalanced < maxUnbalanced) {
    const start = text.indexOf(open, from)
    if (start === -1) return
    const end = balancedEnd(text, start, open, close)
    if (end === -1) {
      unbalanced++
      from = start + 1
      continue
    }
    yield text.slice(start, end + 1)
    from = end + 1
  }
}

/** The slices to try, in order; see {@link extractJsonCandidates}. */
function* candidateSlices(text: string, o: ResolvedExtractOptions): Generator<string> {
  yield* fenceBodies(text, o.fenceLanguages)
  const tagged = o.tagPattern ? text.match(o.tagPattern)?.[1].trim() : undefined
  if (tagged) yield tagged
  yield* balancedSlices(text, '{', '}', o.maxUnbalancedStarts)
  yield* balancedSlices(text, '[', ']', o.maxUnbalancedStarts)
  yield text
}

/**
 * Every JSON value in model text, in order: each fence body whose language is listed (its whole
 * JSON value first, when that runs past the nearest ```), the `<tag>` region, each balanced
 * `{…}`, each balanced `[…]`, then jsonrepair over the whole text. Lazy, so
 * a caller can stop at the first value it accepts. Checks its options at once (a `RangeError`) and
 * never throws after that. Text with no `{` and no `[` yields nothing, so prose never reaches
 * jsonrepair (which throws on the first stray apostrophe).
 */
export function extractJsonCandidates(text: string, opts?: ExtractOptions): Generator<unknown> {
  return jsonCandidates(text, resolveExtractOptions(opts))
}

/** {@link extractJsonCandidates} with options already resolved. */
export function* jsonCandidates(text: string, o: ResolvedExtractOptions): Generator<unknown> {
  if (!text || (!text.includes('{') && !text.includes('['))) return
  for (const slice of candidateSlices(text, o)) {
    const value = repairParse(slice)
    if (value !== null) yield value
  }
}
