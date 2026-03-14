# Spec: smoke route

> [!CAUTION]
> FAILED_BLOCKER: unresolved BLOCKING issues remain. Do not implement without refactor.

## Summary
Implement a dedicated HTTP "smoke route" (health check endpoint) that returns a `200 OK` response when the application is running and ready to serve traffic. This endpoint is **strictly for infrastructure/load balancer liveness checks** and must **not** depend on any downstream services (databases, caches, external APIs) or perform business logic. Its sole purpose is to confirm the application process is alive and the HTTP server is accepting requests.

**Endpoint:** `GET /healthz`  
**Success Response:** `200 OK` with empty body or `{"status":"ok"}`  
**Failure Response:** `503 Service Unavailable` if the application is shutting down or in a known broken state (e.g., failed startup).  
**Key Principle:** Zero external dependencies. Must respond even if all other systems are down.

---

## Architecture
### Placement & Integration
*   **Router/Module:** The route will be registered in the **core application router** (e.g., Express `app.js`, Spring `@RestController`, Django `urls.py`) **before** any business logic routes.
*   **Handler:** A single, synchronous function/method that:
    1.  Checks an in-memory `isShuttingDown` flag (set by SIGTERM/SIGINT handlers).
    2.  If `isShuttingDown` is `true`, returns `503`.
    3.  Otherwise, returns `200` immediately.
*   **Middleware Exclusion:** The route **must bypass** all application-level middleware that could block or fail (authentication, rate limiting, logging, tracing, CORS). Only essential framework middleware (e.g., body parsing) may apply if it's guaranteed to be stable.
*   **Configuration:** The path (`/healthz`) should be a **hardcoded constant** in the source, not configurable via environment variables, to prevent misconfiguration from breaking the check.

### Tradeoffs
*   **Simplicity vs. Extensibility:** We intentionally implement a **binary "up/down" check**. We do *not* include component health (DB, cache) here. This avoids false negatives from downstream issues and keeps the endpoint ultra-reliable. A separate, more detailed `/ready` endpoint could be added later for dependency checks.
*   **Performance vs. Safety:** The handler does **no work** beyond a flag check. This guarantees sub-millisecond response times and zero load on other systems, but provides no insight into application health beyond process liveness.

---

## Implementation Changes
### 1. Add Health Check Handler
Create a new module/file: `src/health/check.js` (or equivalent).
```javascript
// Example (Node.js/Express)
let isShuttingDown = false;

// Export function to set flag from signal handlers
export const setShuttingDown = (flag) => { isShuttingDown = flag; };

export const healthCheckHandler = (req, res) => {
  if (isShuttingDown) {
    return res.status(503).send('Service Unavailable');
  }
  res.status(200).json({ status: 'ok' });
};
```

### 2. Register Route Early
In main application file (`src/server.js` or `app.py`), **before** other routes:
```javascript
import { healthCheckHandler } from './health/check';
app.get('/healthz', healthCheckHandler); // Express example
```

### 3. Wire Shutdown Signal
In the same startup file, add signal handlers to set the flag:
```javascript
process.on('SIGTERM', () => {
  console.log('SIGTERM received: setting shuttingDown flag');
  setShuttingDown(true);
  // Initiate graceful shutdown after a delay...
});
process.on('SIGINT', () => { /* similar */ });
```

### 4. Exclude from Middleware (if framework supports)
*   **Express:** Place route registration **before** `app.use(authenticateMiddleware)`.
*   **Spring Boot:** Use `@RequestMapping(path = "/healthz", method = RequestMethod.GET)` on a bean with `@Order(Ordered.HIGHEST_PRECEDENCE)`.
*   **Django:** Add `path('healthz', health_check_view)` at the **top** of `urlpatterns`.

### 5. Monitoring Integration (Optional but Recommended)
*   Add a log line on every request to `/healthz` at `DEBUG` level (to avoid log spam, consider sampling 1% or only on non-200).
*   Ensure the endpoint is **not** included in application performance monitoring (APM) transaction tracing by default.

---

## Test Plan
### Unit Tests
*   **Test 1:** `healthCheckHandler` returns `200` when `isShuttingDown` is `false`.
*   **Test 2:** `healthCheckHandler` returns `503` when `isShuttingDown` is `true`.
*   **Test 3:** `setShuttingDown` correctly updates the flag.

### Integration Tests
*   **Test 4:** Start the full application. `curl -f http://localhost:3000/healthz` returns `200` and JSON body `{"status":"ok"}`.
*   **Test 5:** Send `SIGTERM` to the process. Wait 100ms. `curl -f` should return `503`.
*   **Test 6:** Verify the route is accessible **without** authentication headers/tokens.
*   **Test 7:** Verify the route is **not** subject to rate limiting (if a rate limiter is present, it should exclude `/healthz`).

### Negative/Chaos Tests
*   **Test 8:** Simulate a scenario where the main event loop is blocked (e.g., infinite sync loop). The endpoint **will not respond**—this is an acceptable failure mode as the process is hung. Document this as a risk.
*   **Test 9:** Test with a load balancer (e.g., nginx) configured to hit `/healthz`. Verify it correctly interprets `200` as healthy and `503` as unhealthy.

### Manual Verification
*   Use `curl -v http://localhost:3000/healthz` during development.
*   Check that response time is consistently < 5ms.

---

## Risks & Mitigations
| Risk | Likelihood | Impact | Mitigation |
| :--- | :--- | :--- | :--- |
| **Route not registered early enough** | Medium | High (LB marks all instances down) | **Code Review Checklist:** Verify `/healthz` is the **first** route in the router. Add an integration test that fails if other routes are registered before it. |
| **Handler throws an exception** | Low | High (500 error -> LB marks down) | Handler must be **extremely simple**—only a boolean check. No `try/catch` needed if code is this simple. Add unit test to ensure no exceptions. |
| **Accidental dependency introduced** | Medium | High (DB down -> health fails) | **Code Review:** Explicitly forbid `import` of DB clients, HTTP clients, or business modules in `health/check.js`. Use static analysis (ESLint rule) to ban certain imports in that directory. |
| **Endpoint exposed publicly & scraped** | Medium | Low (info leak, minor load) | Path is non-standard (`/healthz` not `/health`). No sensitive data returned. Consider network-level firewall rules to restrict to LB IPs if security policy requires. |
| **Misconfigured LB uses wrong path/port** | Medium | High (Health checks fail) | **Documentation:** Clearly state expected path (`/healthz`) and port (app port, not a separate admin port). Provide example LB config snippets. |
| **Process is CPU-bound/hung but flag is false** | Medium | Medium (LB sees 200 but app is unusable) | **Accepted Limitation:** Smoke route only checks process liveness, not responsiveness. For that, a separate `/ready` endpoint with a short timeout on a lightweight DB query is needed. Document this distinction. |
| **Shutdown flag not set in time** | Low | Medium (LB continues routing to terminating pod) | Ensure signal handler sets flag **immediately** before any async cleanup. Test with `SIGTERM` -> immediate `curl` should get `503`. |

### Explicit Tradeoff Acknowledgement
*   **We choose not to check dependencies** (DB, Redis) in this endpoint because:
    1.  It would make the health check **fragile** and **slow**.
    2.  It would create **circular dependencies** (health check requires DB, but DB might be overloaded).
    3.  The load balancer's job is to detect **process death**, not **application errors**. A `200` with a `503` on every business request is a valid (if degraded) state.
*   **Failure Mode:** The endpoint can return `200` while the application is functionally broken (e.g., config error, bug). This is **by design**. Operational teams must monitor business metrics (error rates, latency) separately.

## Post-Implementation Review

- B1 (BLOCKING): The spec assumes a global `isShuttingDown` flag that is set by signal handlers, but this creates a race condition: if the signal handler sets the flag after the health check reads it, the endpoint may briefly return `200` during shutdown. This violates the requirement that `SIGTERM` should immediately result in `503`. -> Implement the shutdown flag as an `Atomics` boolean or use a `Promise`/`EventEmitter` that the health check handler awaits. For example, in Node.js: use `Atomics.wait`/`Atomics.notify` or a `process.nextTick` queue to ensure the flag is visible before the health check runs. Alternatively, have the signal handler set a `process.exitCode` and have the health check check both the flag and `process.exitCode !== 0`.
- B2 (BLOCKING): The spec states the route must bypass all middleware, but provides no concrete mechanism to guarantee this across frameworks. In Express, placing the route before middleware registration is not sufficient if middleware is added later or if the router is reconfigured. In Spring Boot, `@Order` may not prevent filters from running. This is a critical architecture flaw that could cause the health check to fail due to authentication/rate limiting. -> Define a framework-specific exclusion mechanism: for Express, use a dedicated router instance for `/healthz` that is not attached to the main app's middleware chain. For Spring Boot, use a separate `@Controller` with `@CrossOrigin` and a `FilterRegistrationBean` that excludes `/healthz`. For Django, use a separate URLconf that is included before the main one. Document these patterns explicitly.
- B3 (BLOCKING): The spec allows the health check to return `200` even if the process is hung (e.g., infinite sync loop). This is an "accepted limitation" but creates a scenario where the load balancer thinks the app is healthy while it's actually unresponsive. This is a critical failure mode for production systems. -> Add a timeout mechanism to the health check: use `process.hrtime.bigint()` to track the last successful check, and if the current check takes longer than a threshold (e.g., 100ms), return `503`. Alternatively, use a separate watchdog thread/process that monitors the main process's responsiveness and sets the shutdown flag if it's unresponsive.
- B4 (BLOCKING): The spec does not address the case where the application fails to start up (e.g., config error, port in use). In this case, the health check endpoint may never be registered, causing the load balancer to mark the instance as down immediately. However, there's no mechanism to distinguish between "app is starting" and "app failed to start." -> Add a startup state machine: track `isStarting`, `isRunning`, `isShuttingDown`. The health check should return `503` if `isStarting` is true or if startup failed. Use a `Promise` that resolves on successful startup and rejects on failure, and have the health check check this promise's state.
- B5 (BLOCKING): The spec does not specify how to handle multiple instances of the application (e.g., in a cluster). If each instance has its own `isShuttingDown` flag, a rolling update could cause some instances to return `503` while others return `200`, leading to inconsistent health check results. -> Use a distributed coordination mechanism (e.g., Redis, etcd) to track the shutdown state across all instances. Alternatively, document that each instance manages its own state and that the load balancer should use a gradual shutdown strategy (draining connections before setting the flag).

## Metadata

- Status: `FAILED_BLOCKER`
- Rounds used: `1`
- Tiers used: `1`
- Unresolved blocking issues: `5`