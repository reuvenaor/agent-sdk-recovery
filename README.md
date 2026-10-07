# agent-sdk-recovery

[![npm version](https://img.shields.io/npm/v/agent-sdk-recovery)](https://www.npmjs.com/package/agent-sdk-recovery)
[![CI](https://github.com/reuvenaor/agent-sdk-recovery/actions/workflows/ci.yml/badge.svg)](https://github.com/reuvenaor/agent-sdk-recovery/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/reuvenaor/agent-sdk-recovery/badge)](https://scorecard.dev/viewer/?uri=github.com/reuvenaor/agent-sdk-recovery)
[![License](https://img.shields.io/github/license/reuvenaor/agent-sdk-recovery)](LICENSE)
[![Node](https://img.shields.io/node/v/agent-sdk-recovery)](package.json)

Gets a structured result out of an agent `query()` that was given an `outputFormat`, even when
the result has no `structured_output`. It looks at the `StructuredOutput` inputs the CLI
rejected, then at the result text and the session's assistant texts. It finds the JSON, repairs
it where it can, and checks it against your schema. It imports no agent SDK: it reads plain
result fields. The examples use the
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), whose result
messages fit its input.

A community project, not affiliated with, endorsed by or sponsored by Anthropic. "Claude" is a
trademark of Anthropic, PBC, and is named here only to say which SDK this package was built for.
Your use of the SDK itself is governed by
[Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance).

## Contents

- [Install](#install)
- [Compatibility](#compatibility)
- [Quick start](#quick-start)
- [`recoverStructuredOutput(result, schema, opts?)`](#recoverstructuredoutputresult-schema-opts)
- [Rungs](#rungs)
- [The `tool_input` rung](#the-tool_input-rung)
- [`extractJsonCandidates(text, opts?)`](#extractjsoncandidatestext-opts)
- [Good to know](#good-to-know)
- [Why](#why)
- [Dependencies](#dependencies)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Install

```bash
npm install agent-sdk-recovery
```

Bring your own schema library. The examples use zod:

```bash
npm install zod
```

## Compatibility

| Needs             | Version                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node              | 22.12 or later. The package is ESM only; CommonJS code can `require()` it on 22.12+.                                                                       |
| TypeScript        | 5.4 or later (the types use `NoInfer`).                                                                                                                    |
| Module resolution | `node16`, `nodenext` or `bundler`. The old `node10` (`"node"`) cannot resolve it.                                                                          |
| Schema            | Any [Standard Schema](https://standardschema.dev) v1 validator: zod 3.24+, Valibot 1.0+, ArkType 2.0+, or one you write. Sync and async schemas both work. |
| Agent SDK         | Not a dependency. CI type-checks the examples below against `@anthropic-ai/claude-agent-sdk` 0.3.                                                          |

## Quick start

```ts
import { query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { recoverStructuredOutput } from 'agent-sdk-recovery'
import { z } from 'zod'

const Report = z.object({ summary: z.string() })

export async function report(prompt: string, options: Options) {
  // The CLI validates with draft-07; see "Good to know".
  const outputFormat = {
    type: 'json_schema' as const,
    schema: z.toJSONSchema(Report, { target: 'draft-7' }),
  }

  // Collect the session's top-level assistant texts while the query runs.
  const assistantTexts: string[] = []
  let result: SDKResultMessage | undefined
  for await (const message of query({ prompt, options: { ...options, outputFormat } })) {
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      const text = message.message.content
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join('\n')
      if (text) assistantTexts.push(text)
    }
    if (message.type === 'result') result = message
  }

  const { value, via, rejected } = await recoverStructuredOutput(
    { ...result, assistantTexts },
    Report,
  )
  if (value === null) {
    // Every rung missed. You decide whether that is fatal.
  }
  return { value, via, rejected }
}
```

## `recoverStructuredOutput(result, schema, opts?)`

Tries each rung in order and returns the first candidate that passes `schema`. The default
rungs are:

1. `structured_output`: the SDK's own validated payload.
2. `tool_input`: the `StructuredOutput` inputs the CLI rejected, in
   `result.structuredOutputInputs`, latest first (see [The `tool_input` rung](#the-tool_input-rung)).
3. `result_text`: the JSON candidates in `result.result`.
4. `assistant_text`: the JSON candidates in `result.assistantTexts`, longest text first. A
   session that ends on a tool call, or hits `error_max_turns`, often left its JSON in an
   earlier message.

It returns a promise of a `RecoveredOutput`:

- `value`: the parsed value, typed from the schema; `null` on a miss.
- `via`: the name of the rung that answered, or `'none'`. Its type is the union of the rung
  names you passed, plus `'none'`, and a check on it narrows `value`.
- `rejected`: set when `structured_output` was present but failed the schema; one
  `path/to: message` line per issue. The CLI checks only what JSON Schema can express, so it
  can accept a payload your schema rejects. `rejected` tells that case apart from "no payload".

| Option  | Default          | What it changes                                              |
| ------- | ---------------- | ------------------------------------------------------------ |
| `rungs` | `defaultRungs()` | The rungs to try, in order. `via` is typed from their names. |

Every rung runs whatever the result `subtype` is: an error result often still has the JSON in
its assistant texts. A miss is a value, not an error. Two things do throw: a rung named
`'none'` (a `TypeError`, since `'none'` is the name of a miss), and any error a custom rung or
the schema throws, which stops the ladder and reaches you.

## Rungs

A rung is `{ via, candidates(result) }`: a name and the raw values it offers, as a sync or an
async iterable. The ladder validates each value against the schema, so a rung never validates.

- `fromStructuredOutput(o?)`, `fromStructuredOutputInputs(o?)`, `fromResultText(o?)`,
  `fromAssistantTexts(o?)`: the four built-in rungs.
- `defaultRungs(o?)`: the four in the default order. `o` goes to the two text rungs.
- `candidatesOf(result, rungs?)`: every raw candidate the rungs offer for `result`, in order.

| Option  | Default               | What it changes                                                  |
| ------- | --------------------- | ---------------------------------------------------------------- |
| `via`   | the rung's name above | The name `via` reports when this rung answers.                   |
| `order` | `'longest'`           | `fromAssistantTexts` only: `'latest'` tries the last text first. |

The two text rungs also take the `extractJsonCandidates` options below. A bad option value
throws a `RangeError` that names the option, when you build the rung.

A custom rung can run a new query and offer that result's candidates. Use `candidatesOf`, so
the ladder validates them like any others:

```ts
import {
  candidatesOf,
  defaultRungs,
  recoverStructuredOutput,
  type RecoverableResult,
  type Rung,
} from 'agent-sdk-recovery'
import { z } from 'zod'

const Report = z.object({ summary: z.string() })

// askAgain is your own follow-up query. It returns that query's result, or null.
export async function withReask(
  result: RecoverableResult,
  askAgain: () => Promise<RecoverableResult | null>,
) {
  const reask: Rung<'reask'> = {
    via: 'reask',
    async *candidates() {
      const retry = await askAgain()
      if (retry) yield* candidatesOf(retry)
    },
  }
  const out = await recoverStructuredOutput(result, Report, { rungs: [...defaultRungs(), reask] })
  // out.via: 'structured_output' | 'tool_input' | 'result_text' | 'assistant_text' | 'reask' | 'none'
  return out
}
```

## The `tool_input` rung

Opus 5.5 often ends a long `StructuredOutput` input one closing brace short
([claude-code#98860](https://github.com/anthropics/claude-code/issues/98860)). The CLI rejects
the call, and the model writes the whole answer again, up to the retry cap. The result then ends
`error_max_structured_output_retries` with no `structured_output`, while the answer sat in the
rejected input.

The rung reads `result.structuredOutputInputs`: the raw JSON input of each rejected call, in call
order. It offers an input only when the input fails to parse as it is and parses once its missing
closing brackets are added. It skips an input that:

- parses as it is: the CLI checked it against your schema and refused it;
- ends inside a string: the text was cut, and a repair would only make a smaller object;
- still fails to parse with the brackets added, for example one that ends after a comma.

The rung cannot tell a dropped brace from an input cut after a complete value. A number cut in
the middle of its digits looks complete: `{"count": 12` becomes `{"count": 12}`. A list cut
between items looks complete too: `{"files": ["a.ts", "b.ts"` becomes
`{"files": ["a.ts", "b.ts"]}`, and the rest of the list is lost. Your schema passes both.

So `structuredOutputInputs` holds whole inputs only: leave out every call whose message stopped
with `max_tokens` or `model_context_window_exceeded`. The CLI can answer a call before its
message's stop reason arrives, so filter when the query ends.

The SDK result has no such field, so fill it yourself. The CLI's own record of a rejected call,
`__unparsedToolInput.raw` in the assistant message, is cut at 2048 bytes. The stream deltas carry
the whole input:

```ts
import { query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { recoverStructuredOutput } from 'agent-sdk-recovery'
import { z } from 'zod'

const Report = z.object({ summary: z.string() })

export async function run(prompt: string, options: Options) {
  const open = new Map<number, { id: string; json: string }>()
  const done = new Map<string, string>()
  let stopped: string[] = [] // the calls whose block stopped in the current message
  const cut = new Set<string>()
  const rejected: { id: string; input: string }[] = []
  let result: SDKResultMessage | undefined
  // includePartialMessages turns on the stream events that carry the deltas.
  const q = query({ prompt, options: { ...options, includePartialMessages: true } })
  for await (const message of q) {
    if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
      const e = message.event
      if (e.type === 'message_start') {
        open.clear()
        stopped = []
      }
      if (e.type === 'content_block_start' && e.content_block.type === 'tool_use') {
        if (e.content_block.name === 'StructuredOutput') {
          open.set(e.index, { id: e.content_block.id, json: '' })
        }
      }
      if (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta') {
        const call = open.get(e.index)
        if (call) call.json += e.delta.partial_json
      }
      if (e.type === 'content_block_stop') {
        const call = open.get(e.index)
        if (call) {
          done.set(call.id, call.json)
          stopped.push(call.id)
        }
        open.delete(e.index)
      }
      // An output limit may have cut this message's calls short.
      const reason = e.type === 'message_delta' ? e.delta.stop_reason : null
      if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') {
        for (const id of stopped) cut.add(id)
      }
    }
    // Keep each call that the CLI answered with an error.
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue
        const input = done.get(block.tool_use_id)
        if (input !== undefined && block.is_error === true) {
          rejected.push({ id: block.tool_use_id, input })
        }
      }
    }
    if (message.type === 'result') result = message
  }

  // Filter only now: the stop reason can arrive after the call's error.
  const structuredOutputInputs = rejected.filter((r) => !cut.has(r.id)).map((r) => r.input)
  return recoverStructuredOutput({ ...result, structuredOutputInputs }, Report)
}
```

## `extractJsonCandidates(text, opts?)`

The values a text rung offers, in this order:

1. the body of each fenced block whose language is in `fenceLanguages`;
2. the first `<tag>…</tag>` region, when `tag` is set;
3. each balanced `{…}`, then each balanced `[…]`, left to right;
4. the whole text.

Each one goes through `jsonrepair`, and a JSON string that holds more JSON is unwrapped. A fence
body ends at the nearest triple backtick, and the scan goes on from there, so a fence that is cut
off never hides the fences after it. When the body's JSON value ends later (a triple backtick
inside a JSON string), the whole value is tried first. Text with no `{` and no `[` gives
nothing. The generator is lazy, so you can stop at the first value you accept.

| Option                | Default                 | What it changes                                                                                                              |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tag`                 | none                    | Also tries the first `<tag>…</tag>` region. A plain identifier, such as `answer`.                                            |
| `fenceLanguages`      | `['', 'json', 'jsonc']` | The fence languages that count as JSON, compared trimmed and lowercase. `''` is a fence with no language.                    |
| `maxUnbalancedStarts` | `64`                    | How many brackets that never close the scan tries, per bracket type, before it stops. Each one reads to the end of the text. |

`EXTRACT_DEFAULTS` holds the defaults. A bad value throws a `RangeError` that names the option.

## Good to know

- **The schema is the only gate.** The first candidate that passes it wins, even a draft or an
  example object the model did not mean as its answer. A strict schema helps.
- **Send draft-07 JSON Schema.** The CLI validates your schema with a draft-07 validator. Before
  CLI 2.1.205, a schema that declares the draft 2020-12 meta-schema was dropped silently: the
  model answered in prose, and the result was `success` with no `structured_output`. Since
  2.1.205 it is a hard error:
  `Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`
  ([claude-code#80402](https://github.com/anthropics/claude-code/issues/80402)). Zod 4's
  `z.toJSONSchema` declares 2020-12 by default, so use
  `z.toJSONSchema(schema, { target: 'draft-7' })`, as the
  [structured outputs guide](https://code.claude.com/docs/en/agent-sdk/structured-outputs)
  says.
- **Refinements are invisible to the CLI.** A zod `.refine()` has no JSON Schema form. The CLI
  accepts a payload that breaks it, and this package then reports that payload in `rejected`.

## Why

Reports of the failures this handles:

- [claude-agent-sdk-typescript#277](https://github.com/anthropics/claude-agent-sdk-typescript/issues/277)
  (open): `subtype: 'success'` with `structured_output` absent.
- [claude-agent-sdk-typescript#77](https://github.com/anthropics/claude-agent-sdk-typescript/issues/77)
  (closed): repeated `error_max_structured_output_retries`.
- [claude-agent-sdk-typescript#105](https://github.com/anthropics/claude-agent-sdk-typescript/issues/105)
  and [#227](https://github.com/anthropics/claude-agent-sdk-typescript/issues/227) (closed):
  `outputFormat` ignored.
- [claude-agent-sdk-python#510](https://github.com/anthropics/claude-agent-sdk-python/issues/510)
  (closed): arrays sent as JSON strings, repeated validation failures, and a silent `None`.
- [claude-agent-sdk-python#502](https://github.com/anthropics/claude-agent-sdk-python/issues/502)
  (open): the data wrapped in an `output` field, so validation fails.
- [claude-code#75086](https://github.com/anthropics/claude-code/issues/75086) (closed): past
  the retry cap the whole run is discarded, with no raw-text fallback.
- [claude-code#98860](https://github.com/anthropics/claude-code/issues/98860) (open): Opus 5.5
  ends a long `StructuredOutput` input one closing brace short, and the CLI rejects it up to the
  retry cap.

## Dependencies

- `jsonrepair`: every candidate of the two text rungs goes through it before the schema check.
- `@standard-schema/spec`: types only. It is a dependency, not a peer, because the published
  `.d.ts` files use it.

## Security

Please do not report a vulnerability in a public issue. Use
[private vulnerability reporting](https://github.com/reuvenaor/agent-sdk-recovery/security/advisories/new)
or email info@reuvenaor.com. [SECURITY.md](SECURITY.md) has the details.

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains the setup,
the checks and the commit style. Everyone who takes part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE) © Reuven Naor
