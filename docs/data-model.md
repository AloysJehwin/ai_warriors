# Data model

## Entities

| Entity | Key fields | Relationships |
| --- | --- | --- |
| Site / Line | id, name, timezone, autonomy level | has many Assets, Runs |
| Pipeline template | id, name, category, version, status | has many Stage definitions |
| Stage definition | name, column, lane, agent, resource, mode, criteria, timeout, escalation role | belongs to Template; edges to next stages; optional loop target |
| Run | id, template version, order ref, started, ETA, status | has many Stage runs |
| Stage run | state, progress, yield, throughput, start, end | has Decisions, Alerts, Metrics, Inputs, Outputs |
| Decision | time, agent, action, reason, confidence, policy result | belongs to Stage run; ledger entry |
| Asset | id, type, zone, status, utilization, OEE | assigned to Stage runs |
| Agent | id, scope, autonomy level, model version | makes Decisions |
| Gate | stage run, required role, status | optionally released by a Validation package |
| Validation package | id, type, title, owner, status, objective, acceptance, sample plan, window, outcome on approval | has Checks, Evidence, Signatures, Audit entries; links to Template, Stage, Gate |
| Check | criterion, method, target, result, source (agent/manual), status | belongs to Validation package |
| Evidence | name, required/optional/agent-generated, file ref, hash, uploader, time | belongs to Validation package; file in Evidence store |
| Signature | role, meaning, signer, time, comment, auth method | ordered chain on Validation package |
| Audit entry | time, actor, action, payload hash, previous hash | append-only, chained |

## Relationships

```mermaid
erDiagram
    SITE_LINE ||--o{ ASSET : has
    SITE_LINE ||--o{ RUN : has
    PIPELINE_TEMPLATE ||--o{ STAGE_DEFINITION : defines
    PIPELINE_TEMPLATE ||--o{ RUN : "executed as"
    STAGE_DEFINITION ||--o{ STAGE_DEFINITION : "next / loop target"
    RUN ||--o{ STAGE_RUN : contains
    STAGE_DEFINITION ||--o{ STAGE_RUN : instantiates
    STAGE_RUN ||--o{ DECISION : records
    STAGE_RUN }o--o{ ASSET : "assigned to"
    AGENT ||--o{ DECISION : makes
    STAGE_RUN ||--o| GATE : "may stop at"
    VALIDATION_PACKAGE |o--o| GATE : releases
    VALIDATION_PACKAGE ||--o{ CHECK : has
    VALIDATION_PACKAGE ||--o{ EVIDENCE : has
    VALIDATION_PACKAGE ||--o{ SIGNATURE : "ordered chain"
    VALIDATION_PACKAGE ||--o{ AUDIT_ENTRY : logs
    DECISION ||--|| AUDIT_ENTRY : "ledger entry"
```

## Notes

- **Audit entries** are hash-chained: each stores the hash of its payload and the hash of the previous entry, so any change breaks the chain.
- **Evidence** files are content-hashed on upload. A changed file is a new version; earlier versions stay in the record.
- **Rolled yield** for a run is the product of the yields of all completed stages.
