#!/usr/bin/env tsx
/**
 * Checks that the package is ready to publish, without publishing it. Builds and packs it, lints
 * the tarball (publint), checks its types from every resolver (attw, ESM-only profile: see the
 * CHANGELOG), then installs the tarball into an empty project. There it compiles a consumer and
 * every `ts` block of the README with `skipLibCheck: false`, runs a smoke test, and loads the
 * package through CommonJS `require()`. The consumer catches what the two linters miss: a
 * dependency the package uses but does not declare.
 *
 * `npm run check:package`. The consumer install reads the npm cache first, then the registry.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const NAME = 'agent-sdk-recovery'
/** Installed beside the tarball, at the versions this package resolves. */
const CONSUMER_DEPS = ['zod', '@anthropic-ai/claude-agent-sdk', 'typescript', '@types/node']

/** Uses the package from outside: zod, a hand-written Standard Schema, every rung kind. */
const CONSUMER = `import {
  extractJsonCandidates,
  fromStructuredOutput,
  fromStructuredOutputInputs,
  recoverStructuredOutput,
  type RecoverableResult,
} from 'agent-sdk-recovery'
import { z } from 'zod'

const Status = z.object({ summary: z.string() })

// A Standard Schema written by hand, with no library.
const Even = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: (v: unknown) =>
      typeof v === 'number' && v % 2 === 0
        ? { value: v }
        : { issues: [{ message: 'not an even number' }] },
    types: undefined as unknown as { input: unknown; output: number },
  },
} as const

export async function consume(result: RecoverableResult): Promise<string> {
  const status = await recoverStructuredOutput(result, Status)
  const summary: string | null = status.value?.summary ?? null
  const even = await recoverStructuredOutput(result, Even, {
    rungs: [fromStructuredOutput({ via: 'sdk' })],
  })
  const via: 'sdk' | 'none' = even.via
  const n: number | null = even.value
  const input = await recoverStructuredOutput(result, Status, {
    rungs: [fromStructuredOutputInputs()],
  })
  const inputVia: 'tool_input' | 'none' = input.via
  return [summary, via, n, inputVia, [...extractJsonCandidates('{}')].length].join(' ')
}
`

/** Loads the package and runs two calls. */
const SMOKE = `import { recoverStructuredOutput } from 'agent-sdk-recovery'
import { z } from 'zod'
const Status = z.object({ summary: z.string() })
const got = await recoverStructuredOutput({ result: 'Done: {"summary":"ok"}' }, Status)
if (got.via !== 'result_text' || got.value?.summary !== 'ok') throw new Error('result text: ' + JSON.stringify(got))
const cut = await recoverStructuredOutput({ structuredOutputInputs: ['{"summary":"ok"'] }, Status)
if (cut.via !== 'tool_input' || cut.value?.summary !== 'ok') throw new Error('tool input: ' + JSON.stringify(cut))
console.log('runtime import ok')
`

/** The child env without npm_config_dry_run: under `npm publish --dry-run`, pack and install would write nothing. */
const env = { ...process.env }
delete env.npm_config_dry_run

/** Runs a command and prints its output; throws when it fails. */
function run(cmd: string, args: string[], cwd = root): void {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { cwd, env, stdio: 'inherit' })
}

/** The installed version of a dependency, looked up the way Node does: up the node_modules chain. */
function installedVersion(name: string): string {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'node_modules', name, 'package.json')
    if (fs.existsSync(manifest)) {
      return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string }).version
    }
    if (dir === path.dirname(dir)) throw new Error(`${name} is not installed: run npm install`)
  }
}

/** The body of every ```ts block in the README. */
function readmeBlocks(): string[] {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  return [...readme.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1])
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${NAME}-check-`))
try {
  run('npm', ['run', 'build'])
  const out = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', tmp],
    {
      cwd: root,
      env,
      encoding: 'utf8',
    },
  )
  const [packed] = JSON.parse(out) as { filename: string; entryCount: number }[]
  console.log(`\npacked ${packed.filename} (${packed.entryCount} files)`)
  const tarball = path.join(tmp, packed.filename)

  run('npx', ['publint', 'run', tarball, '--strict'])
  run('npx', ['attw', tarball, '--profile', 'esm-only'])

  const consumer = path.join(tmp, 'consumer')
  fs.mkdirSync(consumer)
  const blocks = readmeBlocks()
  const sources: Record<string, string> = {
    'consumer.ts': CONSUMER,
    ...Object.fromEntries(blocks.map((block, i) => [`readme-${i + 1}.ts`, block])),
  }
  for (const [file, text] of Object.entries(sources)) {
    fs.writeFileSync(path.join(consumer, file), text)
  }
  fs.writeFileSync(path.join(consumer, 'smoke.mjs'), SMOKE)
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: `${NAME}-consumer`, private: true, type: 'module' }, null, 2),
  )
  fs.writeFileSync(
    path.join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: ['node'],
        },
        files: Object.keys(sources),
      },
      null,
      2,
    ),
  )
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      // The SDK's large CLI binary is an optional dependency; its types need none of it.
      '--omit=optional',
      tarball,
      ...CONSUMER_DEPS.map((name) => `${name}@${installedVersion(name)}`),
    ],
    consumer,
  )
  run('npx', ['tsc', '-p', 'tsconfig.json'], consumer)
  run('node', ['smoke.mjs'], consumer)
  // Node >= 22.12 lets CommonJS `require()` an ES module; the CHANGELOG says so.
  run('node', ['--input-type=commonjs', '-e', `require('${NAME}')`], consumer)
  console.log(
    `\ncheck-package: ${NAME} packs, lints, type-checks (with ${blocks.length} README blocks) and loads`,
  )
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
