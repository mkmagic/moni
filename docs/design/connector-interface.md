# Moni — Data-Source Connector Interface

> **Status: 🚧 Stub — not yet written.** Contents to be planned in a dedicated design session. Nothing here is decided.

**Purpose:** The generic plug-in shape for data sources, with `israeli-bank-scrapers` as the first (and only v1.0) implementation.

**Will cover (v1.0):**
- The generic connector interface (adapted from Finlynq's import-connector shape).
- The `israeli-bank-scrapers` implementation and how a scrape flows into the domain layer.
- Where the connector runs (the pg-boss worker) and the short-lived-process credential model.
- Atomic-failure contract: never partial-write; surface breakage; connector is swappable.
- What a connector emits and how normalization/dedup happens before persistence.

**Related:** @../security/threat-model.md · @../security/security-design-principles.md · @domain-layer.md · @../../.agents/skills/israeli-scraper/SKILL.md
