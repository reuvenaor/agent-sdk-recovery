import {
  closeMissingBrackets,
  jsonCandidates,
  resolveExtractOptions,
  type ExtractOptions,
} from './json-extract.js'

/**
 * The result fields the rungs read: an SDK result message, the session's assistant texts, and
 * the raw JSON input of each `StructuredOutput` call the CLI rejected, in call order.
 */
export interface RecoverableResult {
  structured_output?: unknown
  result?: unknown
  assistantTexts?: readonly string[]
  /**
   * Whole inputs only: leave out a call whose message stopped at `max_tokens` or
   * `model_context_window_exceeded`. The `tool_input` rung cannot tell a cut input from a
   * dropped brace.
   */
  structuredOutputInputs?: readonly string[]
}

/**
 * One step of the ladder: a name and the raw candidates it offers. The ladder validates each
 * candidate in order, and the first one that passes wins.
 */
export interface Rung<V extends string = string> {
  /** What `via` reports when this rung answers. `'none'` is reserved for a miss. */
  readonly via: V
  candidates(result: RecoverableResult): Iterable<unknown> | AsyncIterable<unknown>
}

/** The `via` names of a rung list. */
export type RungVia<R extends readonly Rung[]> = R[number]['via']

/** The built-in rungs in their default order. */
export type DefaultRungs = readonly [
  Rung<'structured_output'>,
  Rung<'tool_input'>,
  Rung<'result_text'>,
  Rung<'assistant_text'>,
]

/** The `via` names of {@link DefaultRungs}. */
export type DefaultVia = RungVia<DefaultRungs>

/** Returns `via`; throws a `TypeError` for `'none'`, the name of a miss. */
export function checkRungName<V extends string>(via: V): V {
  if (via === 'none') {
    throw new TypeError(`a rung may not be named 'none': it is the name of a miss`)
  }
  return via
}

/** The SDK's own validated payload, when the result carries one. */
export function fromStructuredOutput<const V extends string = 'structured_output'>(
  o: { via?: V } = {},
): Rung<NoInfer<V>> {
  return {
    // Without `via`, V is its default literal.
    via: checkRungName((o.via ?? 'structured_output') as V),
    *candidates(result) {
      const payload = result.structured_output
      if (payload !== undefined && payload !== null) yield payload
    },
  }
}

/**
 * The rejected `StructuredOutput` inputs, latest first. An input is offered only when it fails to
 * parse as it is and parses once its missing closing brackets are added. It skips an input that
 * parses (the CLI already refused it), ends inside a string, or still fails to parse. It cannot
 * tell a dropped brace from an input cut after a complete value: `{"files":["a.ts","b.ts"`
 * closes into a shorter valid list. So the caller passes whole inputs only.
 */
export function fromStructuredOutputInputs<const V extends string = 'tool_input'>(
  o: { via?: V } = {},
): Rung<NoInfer<V>> {
  return {
    via: checkRungName((o.via ?? 'tool_input') as V),
    *candidates(result) {
      for (const input of [...(result.structuredOutputInputs ?? [])].reverse()) {
        if (typeof input !== 'string') continue
        const value = closeMissingBrackets(input)
        if (value !== undefined) yield value
      }
    },
  }
}

/** The JSON candidates in `result.result`. */
export function fromResultText<const V extends string = 'result_text'>(
  o: ExtractOptions & { via?: V } = {},
): Rung<NoInfer<V>> {
  const extract = resolveExtractOptions(o)
  return {
    via: checkRungName((o.via ?? 'result_text') as V),
    *candidates(result) {
      if (typeof result.result === 'string') yield* jsonCandidates(result.result, extract)
    },
  }
}

/**
 * The JSON candidates in the session's assistant texts. `order: 'longest'` (the default) tries
 * the longest text first; `'latest'` tries the last text first.
 */
export function fromAssistantTexts<const V extends string = 'assistant_text'>(
  o: ExtractOptions & { via?: V; order?: 'longest' | 'latest' } = {},
): Rung<NoInfer<V>> {
  const extract = resolveExtractOptions(o)
  const order = o.order ?? 'longest'
  if (order !== 'longest' && order !== 'latest') {
    throw new RangeError(`order must be 'longest' or 'latest', got ${JSON.stringify(order)}`)
  }
  return {
    via: checkRungName((o.via ?? 'assistant_text') as V),
    *candidates(result) {
      const texts = (result.assistantTexts ?? []).filter((t) => typeof t === 'string' && t !== '')
      if (order === 'latest') texts.reverse()
      else texts.sort((a, b) => b.length - a.length)
      for (const text of texts) yield* jsonCandidates(text, extract)
    },
  }
}

/** The four built-in rungs in their default order; `o` goes to the two text rungs. */
export function defaultRungs(o: ExtractOptions = {}): DefaultRungs {
  return [
    fromStructuredOutput(),
    fromStructuredOutputInputs(),
    fromResultText(o),
    fromAssistantTexts(o),
  ]
}

/** {@link defaultRungs} with no options, built once. */
export const DEFAULT_RUNGS = defaultRungs()

/**
 * Every raw candidate the rungs offer for `result`, in order. A custom rung that dispatches a new
 * query yields these, so the ladder validates them like any other candidate, exactly once.
 */
export async function* candidatesOf(
  result: RecoverableResult,
  rungs: readonly Rung[] = DEFAULT_RUNGS,
): AsyncGenerator<unknown> {
  for (const rung of rungs) yield* rung.candidates(result)
}
