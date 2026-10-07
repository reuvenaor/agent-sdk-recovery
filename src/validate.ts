import type { StandardSchemaV1 } from '@standard-schema/spec'

/** A value that passed the schema, or its issues as `path/to: message` lines. */
export type Validation<T> = { ok: true; value: T } | { ok: false; issues: string[] }

/** Validate once through the schema's `~standard` interface. An async schema is awaited. */
export async function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<Validation<StandardSchemaV1.InferOutput<S>>> {
  const result = await schema['~standard'].validate(value)
  if (result.issues) return { ok: false, issues: result.issues.map(issueLine) }
  // `validate` is typed by the constraint (`unknown`); the output is the schema's own.
  return { ok: true, value: result.value as StandardSchemaV1.InferOutput<S> }
}

/** One issue as `path/to: message`; a root issue is the bare message. */
function issueLine(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? []).map((s) => String(typeof s === 'object' ? s.key : s))
  return path.length === 0 ? issue.message : `${path.join('/')}: ${issue.message}`
}
