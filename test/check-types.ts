// Type tests for the `via` union and the schema's output type. `tsc --noEmit` in `npm test`
// compiles this file; nothing here runs.
import type { z } from 'zod'
import {
  fromResultText,
  fromStructuredOutput,
  recoverStructuredOutput,
  type DefaultVia,
  type RecoverableResult,
  type Rung,
} from '../src/index.js'

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type ViaOf<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>

declare const result: RecoverableResult
declare const Status: z.ZodObject<{ summary: z.ZodString }>

export type DefaultNames = Expect<
  Equal<DefaultVia, 'structured_output' | 'tool_input' | 'result_text' | 'assistant_text'>
>

export async function defaultVia() {
  return (await recoverStructuredOutput(result, Status)).via
}
export type DefaultUnion = Expect<Equal<ViaOf<typeof defaultVia>, DefaultVia | 'none'>>

const custom: Rung<'custom'> = { via: 'custom', candidates: () => [] }
export async function extendedVia() {
  return (
    await recoverStructuredOutput(result, Status, { rungs: [fromStructuredOutput(), custom] })
  ).via
}
export type ExtendedUnion = Expect<
  Equal<ViaOf<typeof extendedVia>, 'structured_output' | 'custom' | 'none'>
>

export async function notInTheList() {
  const via = await extendedVia()
  // @ts-expect-error -- 'result_text' is not a rung of that list
  return via === 'result_text'
}

export async function renamedVia() {
  const rungs = [fromStructuredOutput({ via: 'sdk' }), fromResultText({ via: 'prose' })] as const
  return (await recoverStructuredOutput(result, Status, { rungs })).via
}
export type RenamedUnion = Expect<Equal<ViaOf<typeof renamedVia>, 'sdk' | 'prose' | 'none'>>

export async function renamedInline() {
  return (
    await recoverStructuredOutput(result, Status, {
      rungs: [fromStructuredOutput({ via: 'sdk' }), fromResultText({ via: 'prose' })],
    })
  ).via
}
export type RenamedInlineUnion = Expect<
  Equal<ViaOf<typeof renamedInline>, 'sdk' | 'prose' | 'none'>
>

// A schema typed only as `ZodType<T>` still gives back `T`.
export async function wrapped<T>(schema: z.ZodType<T>): Promise<T | null> {
  return (await recoverStructuredOutput(result, schema)).value
}

export async function wrappedSchema<S extends z.ZodType>(schema: S) {
  return (await recoverStructuredOutput(result, schema)).value
}
export type WrappedValue = Expect<
  Equal<ViaOf<typeof wrappedSchema<typeof Status>>, { summary: string } | null>
>

export async function narrowed(): Promise<string | null> {
  const r = await recoverStructuredOutput(result, Status)
  return r.via === 'none' ? r.value : r.value.summary
}
