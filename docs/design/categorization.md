# Moni — Categorization

> **Status: 🚧 Stub — not yet written.** Contents to be planned in a dedicated design session. Nothing here is decided.

**Purpose:** The deterministic-first, model-as-fallback categorization pipeline and how it interacts with attribute-locking.

**Will cover (v1.0):**
- Rule evaluation order: built-in + user rules first, model only on the unmatched tail.
- Rules-only mode (must work with no model backend configured).
- Caching/freezing a model result against a transaction so the same input never re-categorizes.
- Attribute-locking: human-set categories are skipped by rules and model forever; changes logged with source.
- The rules engine shape (conditions/actions, capped nesting — from Maybe).
- The user-configurable model backend (hosted API key vs. local model) and how the untrusted-string boundary is enforced.

**Related:** @../../vision.md · @conventions.md · @data-model.md
