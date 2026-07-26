# Moni — MCP & API

> **Status: 🚧 Stub — not yet written.** Contents to be planned in a dedicated design session. Nothing here is decided.

**Purpose:** The read-only tool/API surface agents consume, how tenancy is enforced per call, and how encrypted reads get a key.

**Will cover (v1.0):**
- The MCP tool surface (reads only in v1.0 — no write/propose tool exists).
- Tenancy as part of the call context on every tool invocation (from Securo); binding to one user.
- API-key auth for agents: authorization only, never a decryption capability.
- Key availability for headless reads: the unlock-window-gated model + opt-in owner-only warm-key window.
- Tool schemas built from the user's own data (enums per-request); deliberately small page sizes.
- The built-in read-only chat assistant and how it uses these tools.

**Related:** `../security/threat-model.md` · `../security/security-design-principles.md` · `domain-layer.md`
