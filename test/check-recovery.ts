#!/usr/bin/env tsx
// Harness for `agent-sdk-recovery`: one case per ladder rung plus the edge cases. Prints one
// ✓/✗ line per check; exits non-zero on a failure.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
  EXTRACT_DEFAULTS,
  candidatesOf,
  defaultRungs,
  extractJsonCandidates,
  fromAssistantTexts,
  fromResultText,
  fromStructuredOutput,
  fromStructuredOutputInputs,
  type DefaultVia,
  type RecoverableResult,
  type Rung,
  recoverStructuredOutput,
} from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PROSE = fs.readFileSync(path.join(here, 'fixtures', 'prose-report.md'), 'utf8')

const Status = z.object({ files_written: z.array(z.string()), summary: z.string() })
type Status = z.infer<typeof Status>
const GOOD: Status = { files_written: ['e2e/grid.spec.ts'], summary: 'suite written' }
const GOOD_JSON = JSON.stringify(GOOD)
/** An unclosed object inside a `<status>` region, in prose. */
const STATUS_REGION =
  'Status below.\n<status>{"files_written": ["e2e/grid.spec.ts"], "summary": "suite written"</status>\nBye.'
/** Every key present, so the CLI would accept it, but it fails the zod schema. */
const BAD: unknown = { files_written: 'e2e/grid.spec.ts', summary: 'suite written' }

interface Case {
  name: string
  result: RecoverableResult & { subtype?: string }
  expectVia: DefaultVia | 'none'
  expectValue?: Status | null
  /** The exact `rejected` lines; absent → `rejected` must be absent. */
  expectRejected?: string[]
}

const cases: Case[] = [
  {
    name: 'rung 1: structured_output',
    result: { structured_output: GOOD, result: 'ignored' },
    expectVia: 'structured_output',
    expectValue: GOOD,
  },
  {
    // claude-code#98860: the CLI refused an input one closing brace short.
    name: 'rung 2: a rejected StructuredOutput input one brace short',
    result: { structuredOutputInputs: [GOOD_JSON.slice(0, -1)] },
    expectVia: 'tool_input',
    expectValue: GOOD,
  },
  {
    name: 'rung 3: JSON island in result text',
    result: { result: `All done!\n\n\`\`\`json\n${GOOD_JSON}\n\`\`\`\nEnjoy.` },
    expectVia: 'result_text',
    expectValue: GOOD,
  },
  {
    name: 'a bash fence before the json fence',
    result: {
      result: `I ran:\n\`\`\`bash\nnpm test\n\`\`\`\nReport:\n\`\`\`json\n${GOOD_JSON}\n\`\`\``,
    },
    expectVia: 'result_text',
    expectValue: GOOD,
  },
  {
    name: "a JSX {t('…')} in the prose before the report",
    result: { result: `The heading renders {t('home.title')} now.\n\n${GOOD_JSON}` },
    expectVia: 'result_text',
    expectValue: GOOD,
  },
  {
    name: 'an unclosed { before the report',
    result: { result: `The literal { opens here and never closes. Report: ${GOOD_JSON}` },
    expectVia: 'result_text',
    expectValue: GOOD,
  },
  {
    name: 'a jsonc fence',
    result: { result: `Report:\n\`\`\`jsonc\n${GOOD_JSON}\n\`\`\`` },
    expectVia: 'result_text',
    expectValue: GOOD,
  },
  {
    name: 'a jsonc fence with a // comment and a trailing comma',
    result: {
      result:
        'Report:\n```jsonc\n{\n  // the files I wrote\n  "files_written": ["e2e/grid.spec.ts"],\n' +
        '  "summary": "suite written",\n}\n```',
    },
    expectVia: 'result_text',
    expectValue: GOOD,
  },
  {
    // The `{` never balances and jsonrepair cannot read the whole text: only the tag finds it.
    name: 'a <status> region, recovered through the tag option',
    result: { result: STATUS_REGION },
    expectVia: 'result_text',
    expectValue: GOOD,
  },
  {
    // The give-up result carries no `result` text; its report is in the assistant texts.
    name: 'no subtype gate: error_max_structured_output_retries still recovers',
    result: {
      subtype: 'error_max_structured_output_retries',
      assistantTexts: [`I could not match the schema, but here is my report: ${GOOD_JSON}`],
    },
    expectVia: 'assistant_text',
    expectValue: GOOD,
  },
  {
    name: "result:'' with the island in an earlier assistant text",
    result: { result: '', assistantTexts: [`Here is the final status:\n${GOOD_JSON}`] },
    expectVia: 'assistant_text',
    expectValue: GOOD,
  },
  {
    name: 'rung 4: assistant texts tried longest first',
    result: {
      result: 'short ack',
      assistantTexts: [
        `{"files_written": "not-an-array", "summary": 1}`,
        `${'padding '.repeat(20)}the real one: ${JSON.stringify({ ...GOOD, summary: 'from-longest' })}`,
      ],
    },
    expectVia: 'assistant_text',
    expectValue: { ...GOOD, summary: 'from-longest' },
  },
  {
    name: 'error_max_turns: no result field, report recovered from a block',
    result: {
      subtype: 'error_max_turns',
      assistantTexts: ['thinking out loud', `final: ${GOOD_JSON}`],
    },
    expectVia: 'assistant_text',
    expectValue: GOOD,
  },
  {
    name: 'prose everywhere → none (never throws)',
    result: {
      result: "It's done — everything is in place.",
      assistantTexts: ['No JSON here either.'],
    },
    expectVia: 'none',
    expectValue: null,
  },
  {
    name: `long markdown prose report (${PROSE.length} chars, no braces) → none`,
    result: { subtype: 'success', assistantTexts: [PROSE] },
    expectVia: 'none',
    expectValue: null,
  },
  {
    name: 'rejected: a present, schema-invalid payload and nothing else → none, with the issues',
    result: { structured_output: BAD, assistantTexts: ['ok'] },
    expectVia: 'none',
    expectValue: null,
    expectRejected: ['files_written: Invalid input: expected array, received string'],
  },
  {
    name: 'rejected: a later rung still answers, and the issues still ride the result',
    result: { structured_output: BAD, result: `done: ${GOOD_JSON}` },
    expectVia: 'result_text',
    expectValue: GOOD,
    expectRejected: ['files_written: Invalid input: expected array, received string'],
  },
  {
    name: 'rejected: a root issue prints bare, with no path',
    result: { structured_output: 'suite written' },
    expectVia: 'none',
    expectValue: null,
    expectRejected: ['Invalid input: expected object, received string'],
  },
  {
    name: 'rejected: a nested path joins with /, one line per issue',
    result: { structured_output: { files_written: [1] } },
    expectVia: 'none',
    expectValue: null,
    expectRejected: [
      'files_written/0: Invalid input: expected string, received number',
      'summary: Invalid input: expected string, received undefined',
    ],
  },
]

let failures = 0
const report = (ok: boolean, line: string): void => {
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${line}`)
}

for (const c of cases) {
  const { value, via, rejected } = await recoverStructuredOutput(c.result, Status, {
    rungs: defaultRungs({ tag: 'status' }),
  })
  const viaOk = via === c.expectVia
  const valueOk =
    c.expectValue === undefined || JSON.stringify(value) === JSON.stringify(c.expectValue)
  const rejectedOk = JSON.stringify(rejected) === JSON.stringify(c.expectRejected)
  report(
    viaOk && valueOk && rejectedOk,
    `${c.name} → via=${via}${viaOk ? '' : ` (want ${c.expectVia})`}${valueOk ? '' : ` value=${JSON.stringify(value)}`}${rejectedOk ? '' : ` rejected=${JSON.stringify(rejected)}`}`,
  )
}

// A loose schema accepts a cut object, so a fence must offer its whole JSON value first.
const Loose = z.object({ summary: z.string() }).loose()
{
  const whole = { summary: 'use ```bash fences', steps: [1, 2] }
  const { value, via } = await recoverStructuredOutput(
    { result: `Report:\n\`\`\`json\n${JSON.stringify(whole)}\n\`\`\`` },
    Loose,
  )
  report(
    via === 'result_text' && JSON.stringify(value) === JSON.stringify(whole),
    `a \`\`\` inside a JSON string does not end the fence → ${JSON.stringify(value)}`,
  )
}
{
  const { value } = await recoverStructuredOutput(
    {
      result:
        'I first tried {"summary": "draft"}.\n```json\n{"summary": "final", "steps": [1, 2],}\n```',
    },
    Loose,
  )
  report(
    JSON.stringify(value) === '{"summary":"final","steps":[1,2]}',
    `a fence that needs repair wins over a prose {…} before it → ${JSON.stringify(value)}`,
  )
}
{
  // The first fence is cut off, and a stray } in later prose balances its value.
  const { value, via } = await recoverStructuredOutput(
    {
      result:
        '```json\n{"a": {"b": 1}\n```\nNow the real one:\n```json\n{"summary": "final"}\n```\n' +
        'That closes it }\n```text\nbye\n```',
    },
    Loose,
  )
  report(
    via === 'result_text' && JSON.stringify(value) === '{"summary":"final"}',
    `a cut-off fence does not hide the fences after it → ${via} ${JSON.stringify(value)}`,
  )
}

// ── extraction options ─────────────────────────────────────────────────────
{
  const none = await recoverStructuredOutput({ result: STATUS_REGION }, Status)
  report(
    none.via === 'none',
    `without the tag option the <status> region is not read → ${none.via}`,
  )
}
{
  const text = 'Report:\n```yaml\n{"lang": "yaml"}\n```\n```json\n{"lang": "json"}\n```'
  const first = (langs?: string[]): unknown =>
    extractJsonCandidates(text, langs ? { fenceLanguages: langs } : {}).next().value
  report(
    JSON.stringify(first()) === '{"lang":"json"}' &&
      JSON.stringify(first(['YAML'])) === '{"lang":"yaml"}',
    `fenceLanguages picks the fences, compared lowercase → ${JSON.stringify([first(), first(['YAML'])])}`,
  )
}
{
  // Two openers that never balance come before the one that does.
  const text = '{ a { b {"summary": "x"}'
  const found = (max?: number): boolean =>
    [...extractJsonCandidates(text, max ? { maxUnbalancedStarts: max } : {})].some(
      (v) => JSON.stringify(v) === '{"summary":"x"}',
    )
  report(
    found() && !found(2),
    `maxUnbalancedStarts stops the scan → default ${found()}, 2 ${found(2)}`,
  )
}
{
  const thrown = (opts: Parameters<typeof extractJsonCandidates>[1]): string => {
    try {
      extractJsonCandidates('{}', opts)
      return 'no throw'
    } catch (err) {
      return err instanceof RangeError ? err.message : `not a RangeError: ${String(err)}`
    }
  }
  report(
    thrown({ maxUnbalancedStarts: -1 }) === 'maxUnbalancedStarts must be an integer >= 1, got -1',
    `a bad limit throws a RangeError at the call → ${thrown({ maxUnbalancedStarts: -1 })}`,
  )
  report(
    thrown({ tag: 'a>b' }) === 'tag must match /^[a-z][a-z0-9_]*$/i, got "a>b"',
    `a tag that is not an identifier throws a RangeError → ${thrown({ tag: 'a>b' })}`,
  )
  report(
    Object.isFrozen(EXTRACT_DEFAULTS) && Object.isFrozen(EXTRACT_DEFAULTS.fenceLanguages),
    'EXTRACT_DEFAULTS is frozen',
  )
}

// ── any Standard Schema, sync or async ─────────────────────────────────────
{
  // No schema library at all: the `~standard` interface is written by hand.
  const handWritten: StandardSchemaV1<unknown, { n: number }> = {
    '~standard': {
      version: 1,
      vendor: 'hand-written',
      validate: (v) =>
        typeof v === 'object' && v !== null && 'n' in v && typeof v.n === 'number'
          ? { value: { n: v.n } }
          : { issues: [{ message: 'expected a number', path: [{ key: 'n' }] }] },
    },
  }
  const hit = await recoverStructuredOutput({ result: 'done: {"n": 3}' }, handWritten)
  report(
    hit.via === 'result_text' && hit.value?.n === 3,
    `a hand-written Standard Schema recovers → ${JSON.stringify(hit)}`,
  )
  const miss = await recoverStructuredOutput({ structured_output: { n: 'x' } }, handWritten)
  report(
    JSON.stringify(miss.rejected) === '["n: expected a number"]',
    `a { key } path segment prints its key → ${JSON.stringify(miss.rejected)}`,
  )
}
{
  const Async = Status.refine(async (s) => s.files_written.length > 0)
  const r = await recoverStructuredOutput({ structured_output: GOOD }, Async)
  report(
    r.via === 'structured_output',
    `an async refinement recovers instead of throwing → ${r.via}`,
  )
}

// ── the rung list ──────────────────────────────────────────────────────────
{
  const both: RecoverableResult = { structured_output: GOOD, result: `text: ${GOOD_JSON}` }
  const r = await recoverStructuredOutput(both, Status, {
    rungs: [fromResultText(), fromStructuredOutput()],
  })
  report(r.via === 'result_text', `the rungs run in the order given → ${r.via}`)
}
{
  const renamed = await recoverStructuredOutput({ result: GOOD_JSON }, Status, {
    rungs: [fromStructuredOutput({ via: 'sdk' }), fromResultText({ via: 'prose' })],
  })
  report(renamed.via === 'prose', `a built-in rung takes a new name → ${renamed.via}`)
}
{
  // A custom async rung, after the built-ins.
  const fetched: Rung<'fetched'> = {
    via: 'fetched',
    async *candidates() {
      await Promise.resolve()
      yield { files_written: 'not an array' }
      yield GOOD
    },
  }
  const r = await recoverStructuredOutput({ result: 'no json here' }, Status, {
    rungs: [...defaultRungs(), fetched],
  })
  report(
    r.via === 'fetched' && JSON.stringify(r.value) === GOOD_JSON,
    `a custom async rung answers with its first passing candidate → ${r.via}`,
  )
}
{
  // The first passing candidate ends the ladder and closes the rung's generator.
  let closed = false
  let pulledPast = false
  const once: Rung<'once'> = {
    via: 'once',
    *candidates() {
      try {
        yield GOOD
        pulledPast = true
        yield GOOD
      } finally {
        closed = true
      }
    },
  }
  await recoverStructuredOutput({}, Status, { rungs: [once] })
  report(closed && !pulledPast, 'an early win closes the rung and pulls nothing more')
}
{
  const boom: Rung<'boom'> = {
    via: 'boom',
    candidates() {
      throw new Error('dispatch failed')
    },
  }
  const thrown = await recoverStructuredOutput({}, Status, { rungs: [boom] }).then(
    () => 'resolved',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  )
  report(thrown === 'dispatch failed', `a rung that throws stops the ladder → ${thrown}`)
}
{
  const named = (make: () => unknown): string => {
    try {
      make()
      return 'no throw'
    } catch (err) {
      return err instanceof TypeError ? 'TypeError' : String(err)
    }
  }
  const viaNone: Rung<'none'> = { via: 'none', candidates: () => [] }
  const ladder = await recoverStructuredOutput({}, Status, { rungs: [viaNone] }).then(
    () => 'no throw',
    (err: unknown) => (err instanceof TypeError ? 'TypeError' : String(err)),
  )
  report(
    named(() => fromResultText({ via: 'none' })) === 'TypeError' && ladder === 'TypeError',
    `a rung named 'none' throws a TypeError → factory ${named(() => fromResultText({ via: 'none' }))}, ladder ${ladder}`,
  )
}
{
  // `rejected` comes from structured_output even when no rung reads it.
  const r = await recoverStructuredOutput({ structured_output: BAD, result: GOOD_JSON }, Status, {
    rungs: [fromResultText()],
  })
  report(
    r.via === 'result_text' &&
      JSON.stringify(r.rejected) ===
        '["files_written: Invalid input: expected array, received string"]',
    `rejected does not depend on the rung list → ${JSON.stringify(r.rejected)}`,
  )
}
{
  let calls = 0
  const counted: StandardSchemaV1<unknown, Status> = {
    '~standard': {
      version: 1,
      vendor: 'counted',
      validate: (v) => {
        calls++
        return Status['~standard'].validate(v)
      },
    },
  }
  await recoverStructuredOutput({ structured_output: GOOD }, counted)
  const passing = calls
  calls = 0
  await recoverStructuredOutput({ structured_output: BAD }, counted)
  report(
    passing === 1 && calls === 1,
    `structured_output is validated once → ${passing} when it passes, ${calls} when it fails`,
  )
}
{
  const texts = [
    `first ${GOOD_JSON}`,
    `a much longer second text ${JSON.stringify({ ...GOOD, summary: 'last' })}`,
  ]
  const latest = await recoverStructuredOutput({ assistantTexts: [...texts].reverse() }, Status, {
    rungs: [fromAssistantTexts({ order: 'latest' })],
  })
  report(
    latest.value?.summary === 'suite written',
    `order 'latest' tries the last text first, whatever its length → ${latest.value?.summary}`,
  )
  const badOrder = (() => {
    try {
      fromAssistantTexts({ order: 'oldest' as 'latest' })
      return 'no throw'
    } catch (err) {
      return err instanceof RangeError ? err.message : String(err)
    }
  })()
  report(
    badOrder === `order must be 'longest' or 'latest', got "oldest"`,
    `an unknown order throws a RangeError → ${badOrder}`,
  )
}
// ── the tool_input rung ──────────────────────────────────────────────────────
{
  const short = (summary: string): string => JSON.stringify({ ...GOOD, summary }).slice(0, -1)
  const latest = await recoverStructuredOutput(
    { structuredOutputInputs: [short('older'), short('latest')] },
    Status,
  )
  report(
    latest.via === 'tool_input' && latest.value?.summary === 'latest',
    `the latest rejected input is tried first → ${latest.value?.summary}`,
  )
  // The documented limit: the rung cannot see a cut, so the caller passes whole inputs only.
  const listCut = await recoverStructuredOutput(
    { structuredOutputInputs: ['{"summary":"ok","files_written":["a.ts","b.ts"'] },
    Status,
  )
  report(
    listCut.via === 'tool_input' && listCut.value?.files_written.join() === 'a.ts,b.ts',
    `a list cut between items is offered as a shorter list → ${JSON.stringify(listCut.value)}`,
  )
  // Cut mid-key, cut after a comma, and whole: none is offered, so even a loose schema that
  // would take jsonrepair's `{"summary":"ok","files_wri":null}` gets nothing.
  const unusable = ['{"summary":"ok","files_wri', '{"summary":"ok",', '{"summary":"ok"}']
  for (const [name, schema] of [
    ['strict', Status],
    ['loose', Loose],
  ] as const) {
    const r = await recoverStructuredOutput({ structuredOutputInputs: unusable }, schema)
    report(r.via === 'none', `cut or parseable inputs give nothing, ${name} schema → ${r.via}`)
  }
  const mixed = await recoverStructuredOutput(
    // A JavaScript caller can pass anything.
    { structuredOutputInputs: [42, null, short('ok')] as unknown as string[] },
    Status,
  )
  report(
    mixed.via === 'tool_input' && mixed.value?.summary === 'ok',
    `non-string inputs are skipped → ${mixed.via}`,
  )
  const renamed = await recoverStructuredOutput({ structuredOutputInputs: [short('ok')] }, Status, {
    rungs: [fromStructuredOutputInputs({ via: 'input' })],
  })
  report(renamed.via === 'input', `the tool_input rung takes a new name → ${renamed.via}`)
  const texts = {
    structuredOutputInputs: [short('input')],
    result: JSON.stringify({ ...GOOD, summary: 'text' }),
  }
  const withPayload = await recoverStructuredOutput({ ...texts, structured_output: GOOD }, Status)
  const withoutPayload = await recoverStructuredOutput(texts, Status)
  report(
    withPayload.via === 'structured_output' &&
      withoutPayload.via === 'tool_input' &&
      withoutPayload.value?.summary === 'input',
    `structured_output beats tool_input, which beats a passing result text → ${withPayload.via}, ${withoutPayload.via}`,
  )
}
{
  const all: unknown[] = []
  const result = {
    structured_output: BAD,
    structuredOutputInputs: [GOOD_JSON.slice(0, -1)],
    result: GOOD_JSON,
  }
  for await (const c of candidatesOf(result)) all.push(c)
  const want = [BAD, GOOD, ...extractJsonCandidates(GOOD_JSON)]
  report(
    JSON.stringify(all) === JSON.stringify(want),
    `candidatesOf yields the raw candidates in rung order → ${all.length} candidates`,
  )
}

// A `via` check narrows `value`. The type half is enforced by `tsc --noEmit` in `npm test`.
const narrowed = await recoverStructuredOutput({ structured_output: GOOD }, Status)
if (narrowed.via !== 'none') {
  const summary: string = narrowed.value.summary
  report(summary === GOOD.summary, 'via !== none narrows value to the schema output')
} else {
  report(false, 'via !== none narrows value to the schema output (got via=none)')
}

if (failures > 0) {
  console.error(`\ncheck-recovery: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log(`\ncheck-recovery: all ${cases.length} ladder cases pass`)
