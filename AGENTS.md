# agent-panel

<!-- Neutral agent instructions. Tool-specific files (e.g. CLAUDE.md) only import this one.
     HTML comments are stripped before loading: they cost no context. -->

## Overview

chrysa fork of flowy11/agent-panel, a herdr side panel for the focused Claude Code or
Codex session. Fork additions: header lines from a user command (`src/header.mjs`) and
the shown-agent marker. Upstream changes arrive through the weekly upstream-sync PR.

## Commands

- `node --test test/` — run the tests.
- `herdr plugin link . --enabled` — try a local checkout in herdr.

## Conventions

- Everything written to disk is in English (identifiers, commits, docs).
- Configuration comes from environment variables; no committed secrets.
<!-- Only what differs from tool defaults; skip what the code already shows. -->

## Boundaries

- Ask before any action with external effects (push, release, deploy, DNS, secrets, messages).
- Never add assistant attribution to commits, PRs, files or docs.

## Working style

- State assumptions; if a request has several readings, list them and ask before building.
- Smallest change that solves the request: no extra features, abstractions or options.
- Touch only what the task needs; mention unrelated problems instead of fixing them.
- Define a check first (a test, a command), then loop until it passes.
- Reply short: result first, bullet points over paragraphs, long reports in a file.
