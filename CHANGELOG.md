# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, a minor version may
break the API.

## [Unreleased]

## [0.1.0] - 2026-10-07

First release.

### Added

- `recoverStructuredOutput`: a ladder of rungs that returns the first candidate that passes
  any Standard Schema, with `via` typed from the rung names.
- The four built-in rungs, in the default order: `fromStructuredOutput`,
  `fromStructuredOutputInputs` (the `tool_input` rung), `fromResultText` and
  `fromAssistantTexts`. `defaultRungs` and `candidatesOf` build custom ladders.
- `extractJsonCandidates`: the JSON candidates in a text (fences, a tag, balanced brackets, the
  whole text), each one repaired with `jsonrepair`.
- The package is ESM only, for Node 22.12 or later.
  - TypeScript's `moduleResolution: "node10"` (the old `"node"`) cannot resolve it. Use
    `"node16"`, `"nodenext"` or `"bundler"`.
  - CommonJS code on Node 22.12 or later can `require()` it, because Node loads an ES module
    with no top-level `await` that way. `attw` still reports "ESM (dynamic import only)" for a
    CommonJS caller: its TypeScript version predates this Node feature.

[Unreleased]: https://github.com/reuvenaor/agent-sdk-recovery/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/reuvenaor/agent-sdk-recovery/releases/tag/v0.1.0
