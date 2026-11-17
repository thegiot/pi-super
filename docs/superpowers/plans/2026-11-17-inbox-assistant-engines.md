# Inbox assistant engines and direct sending implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Let the owner choose Flash, Pi or Hermes chatassistant with provider/model per chat, put explicitly requested messages into the composer, and send its exact text with Enter.

**Architecture:** Preserve the direct Flash backend as the default. Server-owned catalogs and persisted per-chat selections choose a runner. Hermes uses the existing chatassistant profile, with knowledge integration owned by that profile. The composer continues using the existing idempotent outbox for direct sending.

**Tech Stack:** Node/TypeScript, Svelte 5, installed Pi and Hermes runtimes.

**Spec:** Owner-approved flow in this chat, 17 November 2026.

## Global constraints

- Worktree /workspace/tools/pi-super-inbox and branch inbox-m1 exclusively.
- Push and K29 deployment are authorized after validation.
- Existing privacy exclusions and in-flight invalidation apply across engines.
- Credentials stay server-side. Persist only selection metadata, never conversation text in settings.
- Hermes is explicitly opt-in and uses chatassistant. Its profile controls memory, skills and MCP.
- Informational requests produce answers. Explicit owner requests to write messages may produce drafts and populate the composer. Nonempty composer requires replace/append choice.
- Enter sends exact composer text, Shift+Enter inserts newline. IME composition and repeated key events must not send.

## Review focus

- Switching chats or selections while a request is pending cannot overwrite another composer or restore revoked output.
- Provider/model input must match server catalog and reach the chosen runner without shell interpolation.
- Hermes output, timeouts, approval requests and errors must be handled without retrying actions.
- Direct sending must preserve idempotency, network length limits and existing uncertain-send handling.
- Mobile selectors and long answers must stay usable with the existing separate footer.

## Tasks

- [x] Server engines, safe catalog, persisted per-chat settings, HTTP integration, targeted regression tests.
- [x] Client selectors and model identity, natural draft request mode and composer handoff, direct Enter/button sending and targeted tests.
- [x] Integrate fixtures and mobile harness, review security/correctness, typecheck, timeout tests, build, screenshots.
- [ ] Update local KANBAN and report, scoped commit with Devin trailer, push inbox-m1, fast-forward K29, build/test/restart and live smoke.

## Shared HTTP contract

GET /api/inbox/assistant/options returns { engines: [{ id, label, available, profile?, models: [{ provider, id, label }], default: { provider, model } }], default: { engine, provider, model } }.
Engine ids are flash, pi, hermes. GET/PATCH /api/inbox/chats/:id/assistant-settings returns { engine, provider, model }. PATCH accepts the same object and validates against catalog. Missing selection resolves to catalog default.
POST assistant supports intent answer, draft, auto. Existing omitted intent remains answer for API compatibility. Client free questions use auto; informational chips use answer and drafting chips use draft. Auto instructions allow draft fields only for an explicit request in the owner's prompt. Response adds engine/provider/model metadata. No per-chat content is sent for catalog queries.

## Implementation decisions

Ruling: Hermes invocations from the inbox allow raw skill reads and read-only knowledge MCP tools, and deny Beeper tools and operations with side effects. This preserves the owner-controlled Enter-send flow. It limits which profile tools can be used inside the inbox. The profile used elsewhere keeps its configuration.

The new assistant close method reads thread state, so navigation effects call it inside `untrack` while explicitly tracking route/chat changes. A real mobile run caught and verified this dependency issue.

Direct sending retains the same submission key across socket delivery plus a lost HTTP confirmation. A fresh key becomes available after definite delivery and successful composer handoff. Fifteen focused client tests and scoped review cover that race and stale HTTP snapshots.
