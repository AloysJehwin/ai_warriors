# Product Requirement Document (PRD)

## Project Title

**Ordo** — Autonomous Self-Healing Manufacturing Orchestration Platform

## Hackathon Context

**Google Cloud AI Builder Cup 2026**

**Team:** AI Warriors

**Track:** Manufacturing — Intelligent Operations & Industrial Efficiency

**Target Deployment:** `[https://ordo-ai-warriors.run.app](https://ordo-ai-warriors.run.app)`

**Core Thesis:** Evolving industrial manufacturing from passive dashboard telemetry and manual intervention into a closed-loop multi-agent swarm that detects, predicts, simulates, auto-remediates, and validates physical line operations in real time.

---

## Executive Summary

Modern manufacturing environments (pharmaceutical, electronics, discrete assembly) are crippled by micro-stoppages and manual gate approvals. When operational parameters drift—such as bearing vibration spikes, temperature spikes, or vision quality defects—legacy SCADA/MES applications flag $▲$ out-of-target warnings, pause production, and await human engineering intervention.

**Ordo** addresses this bottleneck by bridging enterprise-grade GxP/21 CFR Part 11 validation workflows with an autonomous agent grid powered by **Google Cloud Vertex AI** and **Gemini 2.0/1.5 Pro**. When line anomalies occur, Ordo’s specialized domain agents negotiate across safety, routing, process, and regulatory constraints to execute real-time line speed adjustments, batch re-routing, automated root cause analysis (RCA), and digital audit sign-offs—resolving up to 80% of line stoppages autonomously while keeping human supervisors in the loop for high-risk decisions.

---

## High-Level System Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       ORDO FRONTEND EXPERIENCE                                         │
│            React / JS Dashboard • Flow • Graph • Ledger • Floor & Fleet • Approvals Inbox              │
└───────────────────────────────────────────────────▲────────────────────────────────────────────────────┘
                                                    │ WebSockets / REST API
┌───────────────────────────────────────────────────┴────────────────────────────────────────────────────┐
│                                   GOOGLE CLOUD RUN BACKEND PLATFORM                                    │
│                                           (FastAPI / Python)                                           │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│  ┌─────────────────────────────┐   ┌─────────────────────────────┐   ┌──────────────────────────────┐  │
│  │   Live Telemetry Pipeline   │   │  Judges' Fault Injector     │   │ Natural Language Builder     │  │
│  │ Pub/Sub ➔ Dataflow ➔ BQuery │   │  Simulate Anomaly Trigger   │   │ (Prompt-to-DAG Pipeline)     │  │
│  └──────────────┬──────────────┘   └──────────────┬──────────────┘   └──────────────┬───────────────┘  │
│                 │                                 │                                 │                  │
│                 └─────────────────────────┬───────┴─────────────────────────────────┘                  │
│                                           ▼                                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                                 DOMAIN AGENT ORCHESTRATION GRID                                  │  │
│  ├──────────────────────────────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                                                  │  │
│  │  1. INSPECTOR / LINE AGENT ──► Anomaly Detection ($▲$ target failure & sensor drift)             │  │
│  │  2. MAINTENANCE AGENT     ──► Vertex AI Time-Series Failure Forecasting (NASA Bearing Model)    │  │
│  │  3. DIAGNOSIS / PROCESS   ──► Gemini Multimodal & Natural Language Root Cause Analysis (RCA)   │  │
│  │  4. HEALER / SCHEDULER    ──► Gemini Tool Calling (`reroute_batch`, `adjust_line_speed`)        │  │
│  │  5. COMPLIANCE AGENT      ──► Auto-Summarization & GxP / 21 CFR Part 11 Digital Audit Ledger     │  │
│  │                                                                                                  │  │
│  └────────────────────────────────────────────────┬─────────────────────────────────────────────────┘  │
│                                                   │                                                    │
└───────────────────────────────────────────────────┼────────────────────────────────────────────────────┘
                                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       PERSISTENCE & ANALYTICS LAYER                                    │
│               Firestore (Live System State)  •  BigQuery (Telemetry & Audit Ledger)                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘

```

---

## Core System Architecture Layers

1. **Shop Floor & Edge Layer (L1/L2):** Simulated OPC UA / MTConnect sensor feeds broadcasting vibration, thermal, cycle time, and vision telemetry.
2. **Data Pipeline & Telemetry Ingestion Layer:** Google Cloud Pub/Sub streaming telemetry through Apache Beam (Dataflow) into BigQuery time-series storage.
3. **Orchestration & Agent Core:** Deployed microservice on **Cloud Run** housing the domain agent swarm, model endpoints, and policy guard.
4. **Validation & Regulatory Layer:** Audit ledger maintaining strict GxP, ISO-22000, and 21 CFR Part 11 validation evidence with e-signature packages.
5. **Experience Surface:** React-based interactive console containing Flow, Graph, Ledger, Floor & Fleet, Approvals Inbox, and Pipeline Builder views.

---

## Domain Agents & AI Engine Specifications

Ordo operates through 8 domain-specific agents, with live Google Cloud AI integrations backing key roles:

```
                  ┌───────────────────────────────────────────────┐
                  │                 POLICY GUARD                  │
                  │   Autonomy Levels: L1 Assist ➔ L4 Autonomous  │
                  └───────────────────────┬───────────────────────┘
                                          │
       ┌──────────────────────────────────┼──────────────────────────────────┐
       │                                  │                                  │
┌──────▼────────┐                  ┌──────▼────────┐                  ┌──────▼────────┐
│ Line Agent    │                  │ Maint. Agent  │                  │ Process Agent │
│ Sensor Drift  │                  │ Vertex AI     │                  │ Gemini RCA &  │
│ & Detection   │                  │ Predictive    │                  │ Multimodal QA │
└──────┬────────┘                  └──────┬────────┘                  └──────┬────────┘
       │                                  │                                  │
       └──────────────────────────────────┼──────────────────────────────────┘
                                          │
                               ┌──────────▼──────────┐
                               │   Healer Agent      │
                               │ Gemini Function     │
                               │ Tool Execution      │
                               └──────────┬──────────┘
                                          │
                               ┌──────────▼──────────┐
                               │ Compliance Agent    │
                               │ Audit Log & GxP     │
                               │ Auto-Sign-off       │
                               └─────────────────────┘

```

| Agent Name | Primary Operational Responsibility | Backing AI Technology |
| --- | --- | --- |
| **Line & Inspector Agent** | Continuous telemetry monitoring & metric threshold enforcement | Rules Engine + Pub/Sub Streaming |
| **Maintenance Agent** | Time-series sensor analysis & failure horizon forecasting | **Vertex AI Time-Series Model** (NASA Bearing Dataset) |
| **Process & Diagnosis Agent** | Deep root-cause analysis, anomaly narration & visual defect triage | **Gemini 1.5 Pro / 2.0 Flash** (Multimodal Vision) |
| **Healer & Scheduler Agent** | Autonomous action execution, batch re-routing, line re-balancing | **Gemini Tool Calling / Function Execution** |
| **Compliance Agent** | GxP validation evidence generation & audit trail preservation | **Gemini Text Summarization** + Firestore Hash Ledger |
| **Planning Agent** | Order fulfillment tracking & material constraint alignment | Linear Optimization / Rules Engine |
| **Supply Agent** | Inventory reservation & raw material shortage flagging | Rules Engine + ERP Mock Connectors |
| **Logistics Agent** | AGV/AMR routing on the shop floor | Pathfinding Algorithms / Rules Engine |

---

## Detailed Functional Features & Gemini Integrations

### 1. Natural Language Pipeline Builder

* **User Intent:** Plant engineers describe production goals using natural language.
* **Implementation:** Gemini converts unstructured descriptions into structured pipeline JSON DAGs.
* **Example Input:** *"Create a discrete assembly line for motor brackets featuring a visual quality check after stage 2 and a thermal hold gate before packaging."*
* **Output:** JSON schema rendered into Ordo's Graph and Flow views.

```json
{
  "pipeline_id": "PIPE-EV-BRACKET-01",
  "name": "Discrete Bracket Assembly",
  "stages": [
    { "id": "ST-01", "name": "Raw Material Prep", "owning_agent": "Supply Agent" },
    { "id": "ST-02", "name": "CNC Machining", "owning_agent": "Line Agent" },
    { "id": "ST-03", "name": "Vision QA Inspection", "owning_agent": "Process Agent", "type": "gate" },
    { "id": "ST-04", "name": "Thermal Curing & Packaging", "owning_agent": "Maintenance Agent" }
  ]
}

```

### 2. Predictive Maintenance Engine (Vertex AI)

* **User Intent:** Predict equipment failure days before a catastrophic stoppage occurs.
* **Implementation:** FastAPI backend queries a Vertex AI endpoint trained on time-series bearing sensor data (vibration, heat, runtime).
* **Output:** Returns failure probability, expected time-to-failure (TTF), and confidence score.

### 3. Anomaly Narrator & RCA Generator

* **User Intent:** Human operators require immediate, natural-language explanations of complex sensor anomalies.
* **Implementation:** Sensor logs and metric variations are passed to Gemini 1.5/2.0 to synthesize a concise Root Cause Analysis (RCA).
* **Example Output:** *"Vibration on CNC-05 increased by 18% over 36 hours alongside an 8°C temperature rise on bearing 2. Predicted failure risk is 22% within 120 hours. Recommended action: Reroute 60 units to CNC-07."*

### 4. Multimodal Quality Triage

* **User Intent:** Inspectors upload thermal scans or visual photos of damaged components or worn line belts.
* **Implementation:** Gemini Vision checks the uploaded image against operational specs, flags surface cracks or belt wear, and sets the stage gate to `Held`.

### 5. Shift Handoff & Validation Summarizer

* **User Intent:** Plant managers need shift summaries and regulatory validation check packages.
* **Implementation:** Gemini processes raw audit ledger events from the past 8 hours to output a GxP-compliant shift handover summary and auto-filled validation check table.

---

## Policy Guard & Autonomy Levels

To ensure safe operation in high-risk manufacturing environments, Ordo implements a 4-tier policy guard:

```
[L1: ASSIST]      ──► AI flags anomalies and suggests fixes; human performs all actions.
[L2: ADVISORY]    ──► AI drafts execution packages; human provides single-click approval.
[L3: CONDITIONAL] ──► AI executes standard low-risk fixes autonomously; alerts human on high-risk breaches.
[L4: AUTONOMOUS]  ──► Full agent swarm execution with auto-generated audit ledger trails.

```

---

## Google Cloud Infrastructure & Mapping

```
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     GOOGLE CLOUD RUN PLATFORM                                  │
│  ┌───────────────────────────────┐  ┌───────────────────────────────┐  ┌────────────────────────────┐  │
│  │   FastAPI Web Microservice    │  │   Vertex AI SDK Integration   │  │  Google GenAI SDK (Gemini) │  │
│  └───────────────┬───────────────┘  └───────────────┬───────────────┘  └─────────────┬──────────────┘  │
└──────────────────┼──────────────────────────────────┼────────────────────────────────┼─────────────────┘
                   │                                  │                                │
┌──────────────────▼──────────────────────────────────▼────────────────────────────────▼─────────────────┐
│                                   GOOGLE CLOUD MANAGED SERVICES                                │
│  ┌───────────────────────────┐  ┌───────────────────────────┐  ┌───────────────────────────────────┐  │
│  │  Cloud Pub/Sub            │  │  Cloud Dataflow           │  │  BigQuery                         │  │
│  │  (Live Sensor Telemetry)  │  │  (Apache Beam Stream ETL) │  │  (Time-series Telemetry Storage)  │  │
│  └───────────────────────────┘  └───────────────────────────┘  └───────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  ┌───────────────────────────────────┐  │
│  │  Cloud Firestore                                         │  │  Firebase Hosting                 │  │
│  │  (Real-Time Agent State & Pipeline DAG Store)            │  │  (Static Asset & React Production)│  │
│  └──────────────────────────────────────────────────────────┘  └───────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘

```

---

## Key Scenarios for Live Hackathon Video Demo

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                DEMO SCENARIO 1: SELF-HEALING LOOP                               │
│                                                                                                 │
│  [User triggers "Simulate Overheat"] ➔ [Stage 3 metric breaches limit: ▲ 88°C]                 │
│                                           │                                                     │
│                                           ▼                                                     │
│  [Maintenance Agent queries Vertex AI] ➔ [Failure risk: 84% in 2 hours]                         │
│                                           │                                                     │
│                                           ▼                                                     │
│  [Gemini Healer Agent executes Tool] ➔ [`reroute_batch(batch_id="R-2417", target="Line_02")`]    │
│                                           │                                                     │
│                                           ▼                                                     │
│  [UI Updates Live in Real-time]      ➔ [Status: Self-Healed | Downtime Avoided: 45 Mins]        │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                           DEMO SCENARIO 2: MULTIMODAL VISION CHECK                              │
│                                                                                                 │
│  [Operator uploads thermal image]    ➔ [Gemini Vision identifies micro-fissure on belt segment] │
│                                           │                                                     │
│                                           ▼                                                     │
│  [Stage Gate status shifts]          ➔ [Status: Held Gate]                                      │
│                                           │                                                     │
│                                           ▼                                                     │
│  [Approvals Inbox auto-populated]    ➔ [Compliance package generated with digital signature]    │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

```

---

## 2-Week Implementation Sprint Plan

### Week 1: Core AI & Gemini Backend Integration

* **Day 1–2:** Build Python FastAPI backend on Cloud Run; integrate `google-genai` SDK with Gemini 1.5/2.0 Flash.
* **Day 3–4:** Implement Function Calling handlers (`reroute_batch`, `adjust_line_speed`) and natural language pipeline generation endpoints.
* **Day 5–7:** Train/deploy Vertex AI custom predictive maintenance endpoint using NASA bearing time-series data; wire to Firestore for real-time state sync.

### Week 2: Streaming Pipeline, UI Polish & Video Submission

* **Day 8–9:** Implement Pub/Sub $\rightarrow$ Dataflow $\rightarrow$ BigQuery telemetry streaming pipeline; hook up live sensor dashboards in React.
* **Day 10–11:** Integrate UI fault-injection controls; implement Gemini shift-handoff summarizer and GxP audit package generator.
* **Day 12–14:** Deploy production build to Cloud Run and Firebase Hosting (`[https://ordo-ai-warriors.run.app](https://ordo-ai-warriors.run.app)`); record 3-minute video walkthrough; publish open-source GitHub repository.

---