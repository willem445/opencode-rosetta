---
name: full
description: Exercises every mapped field
argument-hint: what why
agent: plan
model:
  - Claude Opus 4
  - gpt-5
tools: read, edit
---

Explain ${input:what} given ${input:why} under ${workspaceFolder}, starting at #file:src/index.ts (selection: ${selection}).
