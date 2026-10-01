# Security & compliance

| Area | Approach |
| --- | --- |
| Identity and roles | SSO through the corporate identity provider. Role-based access per site and line; signing rights are bound to roles. |
| Electronic signatures | Each signature records signer, role, meaning, time and comment, and requires re-authentication. Designed to support regulated environments such as 21 CFR Part 11 and EU GMP Annex 11; qualification remains the customer's responsibility. |
| Records | The audit ledger is append-only and hash-chained. Evidence files are content-hashed and versioned. Retention is configurable per site. |
| Network | The OT network is segmented; edge gateways connect outbound only over mutual TLS. Safety PLCs are read-only to Ordo. |
| Safety | Agents never bypass machine safety systems. If the cloud link drops, the edge gateway completes the current safe step and holds. |
| Secrets | Keys and signing keys held in a KMS. |
| Tenancy | Org → site → line isolation. |

Deployment topology is described in [architecture.md](architecture.md#14-deployment-and-availability).
