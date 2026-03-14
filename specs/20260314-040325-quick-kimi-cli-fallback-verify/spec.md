# Spec: quick kimi cli fallback verify

> [!CAUTION]
> FAILED_BLOCKER: unresolved BLOCKING issues remain. Do not implement without refactor.

## SummaryImplement a fallback verification mechanism for the KIMI CLI to ensure functionality when the primary verification service (e.g., external API) is unavailable. The fallback will use a local cache or simplified validation logic to provide a quick, best-effort response. This ensures the CLI remains usable during outages while minimizing user disruption.  

---

## Architecture  
The system will follow a **primary-fallback** pattern:  
1. **Primary Verification**: The CLI first attempts to validate data via the primary service (e.g., `verify-api.kimi.com`).  
2. **Fallback Mechanism**: If the primary service fails (e.g., network error, timeout, or invalid response), the CLI triggers a fallback:  
   - **Local Cache**: Use a TTL (time-to-live) cache of previously verified results.  
   - **Simplified Validation**: Run a lightweight, rule-based check (e.g., regex, checksum, or schema validation).  
3. **Circuit Breaker**: Temporarily disable the primary service after repeated failures to prevent cascading issues.  

**Key Components**:  
- `verify()` function: Orchestrates primary and fallback logic.  
- `FallbackCache`: In-memory store with TTL for cached results.  
- `SimplifiedValidator`: Lightweight validation logic (e.g., regex for format checks).  

---

## Implementation Changes  
1. **Modify `verify()` Logic**:  
   - Add a try-catch block around the primary service call.  
   - On failure, check if the fallback is enabled (configurable via CLI flag `--fallback`).  
   - If enabled, attempt the fallback (cache or simplified check).  

2. **Add Fallback Cache**:  
   - Implement a `FallbackCache` class with:  
     - `get(key)`: Retrieve cached result.  
     - `set(key, value, ttl)`: Store result with expiration.  
   - Use a TTL of 5 minutes to avoid stale data.  

3. **Implement Simplified Validation**:  
   - Add a `SimplifiedValidator` class with methods like:  
     - `validateFormat(input: string): boolean` (e.g., regex for email/UUID).  
     - `validateChecksum(input: string): boolean` (e.g., SHA-256 hash).  

4. **Configuration**:  
   - Add a `--fallback` flag to the CLI to enable/disable the fallback.  
   - Default behavior: Use primary service unless `--fallback` is specified.  

5. **Error Handling**:  
   - Log fallback usage with severity level `WARN`.  
   - Return a `FallbackResult` object with a `success` flag and `reason` (e.g., "Primary service unavailable").  

---

## Test Plan  
1. **Unit Tests**:  
   - Test `FallbackCache` for TTL expiration and key-value storage.  
   - Validate `SimplifiedValidator` against known valid/invalid inputs.  

2. **Integration Tests**:  
   - Simulate primary service failures (e.g., mock API returning 500 errors).  
   - Verify that the CLI falls back to the cache or simplified check.  
   - Test edge cases:  
     - Primary service returns partial/invalid data.  
     - Fallback cache is empty.  

3. **End-to-End Tests**:  
   - Run the CLI with and without the `--fallback` flag.  
   - Confirm that the fallback is only used when the primary fails.  
   - Validate that the CLI outputs a clear message when using the fallback (e.g., "Using fallback verification").  

4. **Performance Testing**:  
   - Measure the time difference between primary and fallback verification.  
   - Ensure the fallback completes within 100ms (target for "quick" response).  

---

## Risks  
1. **Stale Cache Data**:  
   - **Failure Mode**: Cached results may be outdated, leading to incorrect validation.  
   - **Mitigation**: Use a short TTL (5 minutes) and log cache hits/misses.  

2. **Simplified Validation Inaccuracy**:  
   - **Failure Mode**: The fallback may miss critical issues (e.g., semantic errors).  
   - **Mitigation**: Document the limitations of the simplified check and prioritize primary service reliability.  

3. **Circuit Breaker Misconfiguration**:  
   - **Failure Mode**: Overly aggressive circuit breaking could block valid primary requests.  
   - **Mitigation**: Implement a 30-second reset period and monitor failure rates.  

4. **Configuration Complexity**:  
   - **Failure Mode**: Users may misconfigure the `--fallback` flag, leading to unintended behavior.  
   - **Mitigation**: Add a `--help` flag with clear usage examples.  

5. **Performance Overhead**:  
   - **Failure Mode**: Fallback logic could introduce latency if not optimized.  
   - **Mitigation**: Profile the simplified validation and cache operations to ensure sub-100ms response times.  

---  
This specification balances speed and reliability while providing clear guidance for implementation and testing.

## Post-Implementation Review

- B1 (BLOCKING): The spec allows the CLI to silently accept invalid data when the primary service is down and the cache is empty or TTL-expired. A malicious or mis-typed input that passes only the “simplified” regex/checksum will be treated as verified, leading to potential data corruption or security bypass. -> Require that any fallback validation result is **tainted**: return a non-zero exit code and force the caller to opt-in with an extra `--insecure-accept-fallback` flag. Log “FALLBACK ACCEPTED – DATA NOT VERIFIED” to stderr.

## Metadata

- Status: `FAILED_BLOCKER`
- Rounds used: `1`
- Tiers used: `1, 2`
- Unresolved blocking issues: `1`