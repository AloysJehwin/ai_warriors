# Ordo — autonomous manufacturing orchestration

Open the `.dc.html` files directly in a browser (keep `support.js`, `doc-page.js` and `_ds/` next to them).

| File | What it is |
| --- | --- |
| `Ordo Orchestrator.dc.html` | Clickable UI prototype: Pipelines (Flow / Graph / Ledger), Validation, Templates, Run history, Floor & fleet, Approvals, Builder |
| `Ordo Documentation.dc.html` | Product, architecture and validation documentation (printable; File → Print → Save as PDF) |
| `Ordo Architecture.dc.html` | System architecture diagram (1600 px wide) |
| `mockups/` | PNG exports of every screen and the architecture diagram |
| `Data sources.md` | Real-time industrial data providers, endpoints and datasets for building and demoing Ordo |

## Mockups
- `00-architecture.png` — system architecture
- `01-pipeline-flow.png` — pipeline, Flow view
- `02-pipeline-node-block.png` — node block opened
- `03-pipeline-graph.png` — Graph view
- `04-pipeline-ledger.png` — Ledger view
- `05-stage-detail-panel.png` — stage detail panel
- `06-validation-draft.png` — validation package, draft
- `07-validation-review-signoff.png` — validation in review with e-signature
- `08-templates.png` — template library
- `09-run-history.png` — run history
- `10-floor-assets.png` / `11-floor-agents.png` — floor & fleet
- `12-approvals-exceptions.png` — approvals inbox
- `13-pipeline-builder.png` — builder

All data in the prototype and mockups is illustrative.

## Changelog

**v1.0.1 (October 2026)**
- Tables (validation checks, run history, stage metrics) now render when the files are opened directly from disk.
- Stage metrics are compared with their targets; out-of-target values show ▲ and fail the agent pre-check.
- Step run stops at a pending or held gate; approving a gate completes the stage.
- Run ETA shows "Done" only when every stage is complete, and flags "at risk" after the 17:00 due time.
- Run history: runs on one consistent timeline (none in the future), all 15 templates represented, and R-2417 reflects the live pipeline.
- Every stage now has an explicit owning agent (e.g. Predictive maintenance stages belong to the Maintenance agent).
- Mockups 01–13 regenerated from the fixed prototype.
