import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
  DEFAULT_RUNGS,
  checkRungName,
  type DefaultRungs,
  type DefaultVia,
  type RecoverableResult,
  type Rung,
  type RungVia,
} from './rungs.js'
import { validate } from './validate.js'

interface RecoveredBase {
  /**
   * Set when `structured_output` was present but failed the schema, one `path: message` per
   * issue, whatever the rung list is. The CLI validates only what JSON Schema can express, so it
   * can accept a payload that fails here; without this field that looks like no payload at all.
   */
  rejected?: string[]
}

/** A check on `via` narrows `value`: `'none'` carries `null`, every rung name the parsed value. */
export type RecoveredOutput<T, V extends string = DefaultVia> =
  (RecoveredBase & { via: V; value: T }) | (RecoveredBase & { via: 'none'; value: null })

/**
 * Recover a structured result from a query result. Runs the rungs in order (by default
 * `structured_output`, the rejected `StructuredOutput` inputs, the JSON in the result text, then
 * the assistant texts longest first) and validates each candidate with `schema`, any Standard
 * Schema, sync or async. The first candidate that passes wins. A miss resolves to
 * `{ value: null, via: 'none' }` and lets the caller decide. A rung that throws stops the ladder,
 * and its error reaches the caller.
 */
export async function recoverStructuredOutput<
  S extends StandardSchemaV1,
  const R extends readonly Rung[] = DefaultRungs,
>(
  result: RecoverableResult,
  schema: S,
  opts: { rungs?: R } = {},
): Promise<RecoveredOutput<StandardSchemaV1.InferOutput<S>, RungVia<R>>> {
  // DEFAULT_RUNGS is R's default.
  const rungs = (opts.rungs ?? DEFAULT_RUNGS) as R
  for (const rung of rungs) checkRungName(rung.via)
  const payload = result.structured_output
  const checkedPayload =
    payload === undefined || payload === null ? null : await validate(schema, payload)
  const rejected = checkedPayload?.ok === false ? { rejected: checkedPayload.issues } : {}
  for (const rung of rungs) {
    for await (const candidate of rung.candidates(result)) {
      // The payload was checked above; a schema with side effects must not run twice on it.
      const checked =
        checkedPayload !== null && candidate === payload
          ? checkedPayload
          : await validate(schema, candidate)
      if (checked.ok) return { value: checked.value, via: rung.via, ...rejected }
    }
  }
  return { value: null, via: 'none', ...rejected }
}
