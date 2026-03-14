# Spec: smoke test cli-provider wiring

> [!CAUTION]
> FAILED_BLOCKER: unresolved BLOCKING issues remain. Do not implement without refactor.

# Implementation Specification: Smoke Test CLI-Provider Wiring

## Summary  
This document outlines the implementation plan to smoke test the wiring between the CLI (Command Line Interface) and provider components in the system. The goal is to validate that basic command routing, provider invocation, and response handling work as expected in a minimal configuration. Smoke tests will focus on end-to-end command execution without validating business logic or edge cases.

---

## Architecture  
The CLI-provider wiring involves three core components:  
1. **CLI**: Parses user input, validates commands, and routes them to providers.  
2. **Providers**: Implement business logic (e.g., data processing, API calls).  
3. **Middleware**: Handles cross-cutting concerns (logging, validation, error handling).  

**Flow**:  
`CLI → [Command Parsing] → Provider Invocation → [Middleware Processing] → Response`  

**Dependencies**:  
- Providers must register themselves with the CLI during startup.  
- Middleware must be configured to intercept provider responses.  
- An event bus (e.g., RabbitMQ, Kafka) is used for asynchronous communication between components.  

---

## Implementation Changes  
### 1. CLI Modifications  
- Add a `smoke-test` command to trigger provider wiring validation.  
- Implement command registration for providers (e.g., `register_provider("data-processor", DataProcessor)`).  
- Add middleware hooks for logging and validation.  

**Example CLI Code Snippet**:  
```python
def register_provider(name: str, provider: ProviderInterface):
    providers[name] = provider

def smoke_test():
    for provider in providers.values():
        try:
            result = provider.execute("ping")
            log.info(f"Provider {provider.name} responded: {result}")
        except Exception as e:
            log.error(f"Provider {provider.name} failed: {e}")
```

### 2. Provider Adaptations  
- Add a `ping()` method to all providers to return a health status.  
- Ensure providers can be instantiated without dependencies (e.g., mock database connections).  

### 3. Middleware Integration  
- Add a `ValidationMiddleware` to check response formats (e.g., JSON schema).  
- Implement a `LoggingMiddleware` to capture command execution traces.  

---

## Test Plan  
### Test Cases  
1. **Command Parsing**  
   - **Test**: Run `cli smoke-test data-processor`  
   - **Expected**: CLI routes the command to the `data-processor` provider.  
   - **Failure Mode**: CLI crashes or routes to the wrong provider.  

2. **Provider Invocation**  
   - **Test**: Verify `ping()` returns a 200 OK status.  
   - **Expected**: Provider responds with `{"status": "healthy"}`.  
   - **Failure Mode**: Provider throws an unhandled exception.  

3. **Middleware Validation**  
   - **Test**: Inject a malformed response (e.g., `{ "status": "alive" }`).  
   - **Expected**: `ValidationMiddleware` rejects the response.  
   - **Failure Mode**: Middleware fails to validate or crashes.  

4. **Event Bus Integration**  
   - **Test**: Simulate a provider failure (e.g., network timeout).  
   - **Expected**: Event bus retries the command or logs the failure.  
   - **Failure Mode**: Event bus drops messages or causes deadlocks.  

### Test Environment  
- Run tests in a Docker container with mocked dependencies (e.g., no real database).  
- Use pytest for test execution.  

---

## Risks  
1. **False Positives**:  
   - Providers may pass smoke tests but fail under load (e.g., database connection pooling issues).  
   - **Mitigation**: Run stress tests after smoke tests.  

2. **Middleware Overhead**:  
   - Adding validation/logging middleware could introduce latency.  
   - **Tradeoff**: Balance between observability and performance.  

3. **Provider-Specific Failures**:  
   - Some providers may rely on external services (e.g., APIs) that are unavailable during smoke tests.  
   - **Mitigation**: Use circuit breakers to isolate failures.  

4. **Event Bus Instability**:  
   - If the event bus is misconfigured, smoke tests may falsely pass/fail.  
   - **Mitigation**: Validate event bus health before running tests.  

--- 

**Next Steps**:  
- Implement `smoke-test` command and provider `ping()` methods.  
- Write unit/integration tests for each component.  
- Execute tests in staging environment and iterate based on failures.

## Post-Implementation Review

- B1 (BLOCKING): Providers are registered by direct Python call (`register_provider`) inside the CLI process, forcing all provider code to run in the same memory space as the CLI. This collapses the architectural boundary between CLI and provider, eliminates the ability to run providers in separate containers/hosts, prevents independent scaling, and makes the event-bus (Kafka/RabbitMQ) redundant for command traffic. The spec should require that providers self-register with a central registry service (or are discovered via k8s/endpoint API) and that the CLI dispatches commands to them over the event-bus or gRPC/REST, not via in-process function calls. -> Replace the in-process registration mechanism with out-of-process discovery/dispatch: CLI publishes a command message to the bus (or calls a registry) and the provider process consumes it; remove the `providers` dict and direct `provider.execute()` call from the CLI.

## Metadata

- Status: `FAILED_BLOCKER`
- Rounds used: `1`
- Tiers used: `1, 2`
- Unresolved blocking issues: `1`