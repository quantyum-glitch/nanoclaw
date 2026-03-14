# Spec: smoke test kimi fallback

> [!TIP]
> REVIEWED: no unresolved blocking issues were detected in the configured flow.

## Summary
This document updates the smoke‑test specification for the Kimi fallback mechanism to address all BLOCKING reviewer concerns. The revised design adds redundant health checks, load‑tested fallback capacity, automated routing validation, centralized monitoring/alerting, graceful degradation, automated recovery, fine‑grained health checks, precise alert thresholds, service‑state synchronization, and version‑controlled load‑balancer configuration. The goal remains to verify that when the primary Kimi service is unavailable the system gracefully falls back, maintains data consistency, and returns to normal operation without user‑visible disruption.

## Architecture
### Components1. **Primary Kimi Service** – main request handler.  
2. **Fallback Service** – alternate implementation capable of serving the same API contract.  
3. **Load Balancer (LB)** – distributes traffic; supports weighted routing, health‑check‑based routing, and sticky‑session‑free operation.  
4. **Redundant Health‑Check Mechanism** – two independent checkers (active probe & passive telemetry) that report to a Health‑Check Aggregator.  
5. **Health‑Check Aggregator** – evaluates results against configurable thresholds, emits a single health status, and triggers LB routing updates.  
6. **State‑Sync Layer** – shared datastore (e.g., strongly‑consistent DB or distributed cache with write‑through) that both primary and fallback services read/write, guaranteeing a defined consistency model (read‑your‑writes + eventual convergence).  
7. **Monitoring & Alerting System** – centralized (e.g., Prometheus + Alertmanager or equivalent) ingesting health‑check metrics, fallback events, LB routing changes, and sync‑layer lag.  
8. **Configuration Store** – version‑controlled (Git) repository for LB rules, health‑check intervals/thresholds, and sync‑layer parameters, accessed via a CI‑approved change‑approval workflow.  

### Data Flow (Normal)
1. User request → LB (routes to Primary per health status).  
2. Primary processes request, reads/writes via State‑Sync Layer.  
3. Response returned to user.  
4. Active probes periodically hit Primary’s `/health` endpoint; passive telemetry (error rates, latency) is streamed to the Aggregator.  
5. Aggregator updates LB weight: Primary = 100 % when healthy, otherwise shifts weight to Fallback.

### Data Flow (Fallback Trigger)
1. Health‑Check Aggregator detects Primary unhealthy (based on redundant checks & thresholds).  
2. LB re‑weights traffic to Fallback (gradual shift to avoid thundering herd).  
3. Fallback serves requests using the same State‑Sync Layer, ensuring data consistency.  
4. Monitoring logs the fallback event and fires alerts if the shift exceeds defined thresholds or persists beyond a grace period.

### Data Flow (Recovery)
1. Aggregator detects Primary healthy again (sustained healthy probes & telemetry).  
2. LB gradually shifts weight back to Primary.  
3. Fallback continues to drain in‑flight requests; no new traffic sent unless Primary re‑fails.  
4. Recovery event logged and alerted if rollback takes longer than configured SLA.

### Trade‑offs (Updated)
- **Latency:** Minimal added latency from redundant probes; fallback shift is gradual to avoid spikes.  
- **Complexity:** Mitigated by automation (config validation, health‑check aggregation, sync layer).  
- **Cost:** Fallback sized via load‑testing; shared state layer adds modest storage/compute overhead.  

## Implementation Changes
### 1. Redundant Health‑Check Implementation
- **Active Probe:** HTTP GET to `/health` on Primary every `active_interval` (configurable, default 10 s).  
- **Passive Telemetry:** Export error‑rate, latency, and CPU metrics from Primary via sidecar exporter; Aggregator computes a moving‑window score.  
- **Aggregator Logic:** Primary considered healthy if **both** active probe success rate ≥ `active_threshold` (default 90 %) **and** passive score ≥ `passive_threshold` (default 80 %). Configurable via Config Store.  - **Alerting:** If either checker fails to report for `miss_limit` consecutive intervals, fire a *HealthCheckMissing* alert.

### 2. Fallback Service Preparation
- **Load Testing:** Run fallback at 120 % of observed peak primary traffic (using tools like k6 or Locust) before release; capture latency < 200 ms and error rate < 0.1 %.  
- **Resource Allocation:** Autoscaling group with min/max set to handle peak load; CPU/memory targets based on test results.  
- **State Sync:** Both services use the same datastore (e.g., PostgreSQL with synchronous commit or Redis with write‑through). Document consistency model: **read‑your‑writes** for writes originating from either service; background replication ensures eventual convergence (< 5 s).  - **Circuit Breaker:** Fallback embeds a lightweight circuit breaker that trips if downstream dependencies fail, preventing cascading failure.

### 3. Load Balancer Enhancements
- **Dynamic Weighting:** LB API receives health status from Aggregator; updates weight for Primary/Fallback endpoints.  
- **Automated Validation:** CI pipeline runs a LB‑config linter (e.g., `envoy config test` or `nginx -t`) and a simulated failover test using a test cluster; PRs must pass.  
- **Version Control:** All LB configuration files (routes, health‑check params, weighting rules) stored in Git; changes require approval via pull‑request and automated canary validation.  
- **Routing Drift Detection:** Sidecar agent periodically diffs live LB config against Git‑head; drift triggers *ConfigDrift* alert and auto‑revert to last known good version.

### 4. Monitoring, Logging & Alerting
- **Centralized Metrics:** Health‑check results, LB weights, fallback request count, sync‑lag, and circuit‑breaker state exported to Prometheus.  
- **Structured Logging:** Each service emits JSON logs with fields: `timestamp`, `service`, `event_type` (health_check, fallback_trigger, recovery, sync_lag), `details`.  - **Alert Rules:**  
  - `HealthCheckDown` – Primary unhealthy for > 2 × `active_interval`.  
  - `FallbackEngaged` – Fallback weight > 0 % for > 30 s.  
  - `SyncLagHigh` – Replication lag > 5 s.  
  - `ConfigDrift` – LB config differs from Git head.  
  - `HealthCheckMissing` – No checker reports for `miss_limit` intervals.  
- **Dashboards:** Grafana panels showing Primary/Fallback traffic share, health‑check scores, sync‑lag, and alert status.

### 5. Graceful Degradation & Recovery Automation
- **Degradation Mode:** If both Primary and Fallback are unhealthy, LB returns a static JSON response (`{ "status": "degraded", "message": "Service temporarily unavailable, please retry later." }`) with HTTP 503 and logs the event.  
- **Automatic Switchback:** Aggregator issues a *recovery* command to LB only after Primary reports healthy for `stable_period` (default 60 s) continuously.  
- **Rollback Procedure:** If recovery fails (e.g., health flaps), LB can be manually reverted to fallback via a runbook; automation also attempts a second recovery after `backoff_period`.  
- **Endpoint‑Granularity:** Health checks now target individual critical endpoints (e.g., `/api/v1/chat`, `/api/v1/user`) via path‑specific probes; failure of any critical endpoint triggers fallback for the whole service (configurable per‑endpoint weight).

### 6. Precise Alerting Thresholds & Actionability
- Thresholds (`active_interval`, `active_threshold`, `passive_threshold`, `miss_limit`, `stable_period`) are exposed as ConfigMap/SSM parameters; documented with recommended values based on load‑test results.  - Each alert includes runbook links, suggested remediation steps, and severity (critical/warning).  
- Alertmanager routes to on‑call pager (PagerDuty/Opsgenie) and Slack channel; suppression during scheduled maintenance windows.

### 7. Service Synchronization & Consistency Validation
- **Pre‑Deploy Sync Check:** CI job runs a checksum/hash comparison of critical data tables between Primary and Fallback schemas; fails if divergence > 0 %.  
- **Runtime Validation:** A lightweight validator sidecar samples a small percentage of requests, compares responses from Primary and Fallback (when both are healthy) and logs mismatches; triggers *DataDrift* alert if mismatch rate > 0.1 %.  
- **Idempotency Guarantee:** All API endpoints designed to be idempotent where possible; fallback retries use same request ID to avoid duplicate side‑effects.

## Test Plan### Smoke Test (Core)
1. **Primary Down Simulation**  
   - Stop Primary service (or inject network blackhole).  
   - Verify Active Probe fails → Aggregator marks unhealthy → LB shifts weight to Fallback (≥ 80 % within 2 × `active_interval`).  
   - Confirm fallback serves requests with correct data (state‑sync validated).  
   - Check logs for `fallback_trigger` event and alert `FallbackEngaged`.  2. **Fallback Up Validation**     - Send a batch of requests to the system while Primary is down.  
   - Assert latency < 200 ms, error rate < 0.1 %, and responses consistent with Primary’s expected output (via shared state).  
   - Validate monitoring dashboards show fallback traffic share and no `SyncLagHigh` alerts.  

3. **Primary Recovery Simulation**  
   - Restart Primary; wait for health probes to succeed for `stable_period`.  
   - Observe LB weight shifting back to Primary (≥ 80 % within 2 × `active_interval` after stability).  
   - Ensure in‑flight fallback requests drain correctly; no new traffic to fallback unless Primary re‑fails.  
   - Log `recovery` event and verify no `ConfigDrift` or `DataDrift` alerts.  ### Edge Cases
1. **Simultaneous Primary & Fallback Down**  
   - Stop both services.  
   - Expect LB to return degraded 503 response with static message.  
   - Verify `HealthCheckDown` for both services and `DegradedMode` alert.  

2. **Partial Primary Failure (Endpoint‑Specific)**  
   - Disable only `/api/v1/chat` endpoint on Primary (keep others healthy).  
   - Active probe for that endpoint fails → Aggregator marks Primary unhealthy (configurable: fail‑fast on any critical endpoint).  
   - Confirm fallback takes over for all traffic (or for the failed endpoint if granular routing is enabled).  

3. **Health‑Checker Failure**  
   - Stop the active probe exporter while keeping Primary healthy.  
   - Passive telemetry still reports healthy; Aggregator should **not** trigger fallback (demonstrates redundancy).  
   - If both checkers stop, trigger `HealthCheckMissing` alert and fallback after `miss_limit`.  

4. **Config Drift Injection**  
   - Manually alter LB weight via CLI outside Git.  
   - Drift detection agent flags discrepancy → `ConfigDrift` alert and auto‑revert to Git‑head version within 30 s.  

5. **Sync Lag Spike**  
   - Introduce artificial replication delay (e.g., network throttling).  
   - Verify `SyncLagHigh` fires when lag > 5 s; fallback continues to serve reads (eventual consistency) but writes are queued.  

### Monitoring & Logging Verification- Confirm all expected log entries (`health_check`, `fallback_trigger`, `recovery`, `degraded_mode`, `config_drift`, `data_drift`) appear in centralized logging (e.g., Elasticsearch/Loki).  - Validate alert notifications are delivered to on‑call channels with correct severity and runbook links.  - Test alert silencing during a scheduled maintenance window; ensure no false positives.  

## Risks (Mitigated)
| Risk | Mitigation |
|------|------------|
| **Health‑check reliability** | Redundant active + passive probes; configurable thresholds; miss‑limit alerts; automated validation in CI. |
| **Fallback service performance** | Pre‑release load testing at 120 % peak; autoscaling based on observed metrics; circuit breaker to avoid overload. |
| **Routing complexity / misconfiguration** | Version‑controlled LB configs; CI lint + simulated failover test; drift detection & auto‑revert; gradual weight shifts to avoid thundering herd. |
| **Monitoring & alerting gaps** | Centralized metrics & structured logging; explicit alert rules with runbooks; 24/7 on‑call routing; suppression windows. |
| **Simultaneous primary & fallback failure** | Degraded mode static response with 503; user‑friendly messaging; logging & alerting for total outage. |
| **Slow or incorrect recovery** | Stable‑period requirement before switchback; automated weight shift; manual rollback runback; backoff on flapping health. |
| **Partial failures (endpoint‑specific)** | Granular per‑endpoint health checks; configurable fail‑on‑any‑critical‑endpoint; fallback routing for affected paths. |
| **Inadequate alerting thresholds** | Thresholds exposed as tunable parameters; documented recommended values; alerts include severity and remediation steps. |
| **Fallback service readiness / data staleness** | Shared state layer with synchronous writes; read‑your‑writes consistency model; runtime data‑drift validator; pre‑deploy sync checksum. |
| **Load‑balancer configuration drift** | Git‑backed configs; PR‑required changes; automated drift detection agent; canary validation on config updates. |

By incorporating these changes, the smoke test will robustly validate the Kimi fallback mechanism under normal, failure, and edge‑case conditions while ensuring observability, consistency, and operational safety.

## Post-Implementation Review

Review loop passed with no unresolved blocking issues.

## Metadata

- Status: `REVIEWED`
- Rounds used: `2`
- Tiers used: `1, 2`