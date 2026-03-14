# Spec: create a script or system that gets a summary of my twitter list and sends it to my gmail every hour

> [!WARNING]
> UNREVIEWED: critics were unavailable or timed out. Human review required.

## Summary
This revised specification addresses the critical security flaw regarding OAuth token management. The system will securely store and automatically refresh authentication tokens for both Twitter (OAuth 1.0a) and Gmail (OAuth 2.0) using environment variables or a dedicated secrets management service. This ensures long-term reliability and prevents credential exposure.

## Architecture
The system architecture now includes a dedicated **Secure Token Management** component.

1.  **Secure Token Storage**: Tokens are stored outside the codebase.
    *   **Primary Method**: Environment variables (e.g., via a `.env` file excluded from version control).
    *   **Production Method**: Integration with a secrets manager (e.g., HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager).
2.  **Token Refresh Mechanism**:
    *   **Gmail (OAuth 2.0)**: Utilizes the `google-auth` library's built-in refresh logic using a stored `refresh_token`.
    *   **Twitter (OAuth 1.0a)**: Access tokens are long-lived but will be re-authenticated if an API call fails with a 401/403 error, prompting a manual re-authorization flow.
3.  **Twitter API**: Unchanged. Uses `tweepy` with OAuth 1.0a user context.
4.  **Gmail API**: Uses `google-api-python-client` with OAuth 2.0 credentials that support automatic refresh.
5.  **Scheduled Task**: Unchanged. Triggers the script hourly.
6.  **Script (Python)**: Core logic now includes explicit initialization of API clients using credentials sourced from the secure token store and handles token refresh failures gracefully.

## Implementation Changes
1.  **Credential Initialization**:
    *   **Twitter**: `tweepy.OAuth1UserHandler` is initialized using `API_KEY`, `API_SECRET`, `ACCESS_TOKEN`, and `ACCESS_TOKEN_SECRET` sourced from the environment/secrets manager.
    *   **Gmail**: `google.oauth2.credentials.Credentials` is initialized from a stored `token.json` (containing `refresh_token`) or environment variables. The `google-auth` library automatically refreshes the access token using the refresh token when needed.
2.  **Secure Storage Setup**:
    *   Provide clear documentation for setting up a `.env` file for local development.
    *   Provide configuration examples for integrating with a cloud secrets manager for production deployments.
3.  **Error Handling for Token Failures**:
    *   Catch `tweepy.TweepyException` or `google.auth.exceptions.RefreshError`. On token-related failures, log a clear error message and halt execution, alerting the user that re-authorization may be required.
4.  **No Code Changes to API Calls**: The existing endpoints (`lists/show.json`, `lists/statuses.json`, `gmail/v1/users/me/messages`) remain correct.

## Test Plan
1.  **Happy Path with Token Refresh**:
    *   Mock an expired Gmail access token. Verify the `google-auth` library successfully uses the refresh token to obtain a new access token and the email is sent.
    *   Verify the script runs successfully with credentials loaded from environment variables.
2.  **Secure Storage Validation**:
    *   Confirm no credentials are hardcoded in the script or configuration files.
    *   Verify the `.env` file is included in `.gitignore`.
    *   Test that the script fails gracefully with a clear error if required environment variables/secrets are missing.
3.  **Token Failure Handling**:
    *   Test with an invalid/revoked Gmail refresh token. Verify the script logs an appropriate error and exits without crashing.
    *   Test with invalid Twitter credentials. Verify the script logs an appropriate error and exits.
4.  **Rate Limiting & API Errors**: (Existing tests remain) Verify graceful handling of Twitter API rate limits (429) and other transient errors with retry logic/backoff.

## Risks
| Risk | Mitigation | Residual Risk |
| :--- | :--- | :--- |
| **Token Exposure** (Original BLOCKING) | Credentials stored in environment variables/secrets manager, never in code. Strict file permissions and `.gitignore` enforcement. | Risk shifts to host system compromise or secrets manager breach. |
| **Token Refresh Failure** | Clear error logging and non-zero exit code for monitoring. Alerting on script failure. | Requires manual intervention to re-authorize the application if refresh token is revoked/expired. |
| **Secrets Manager Dependency** | Document fallback to environment variables. Choose a reliable provider with high SLA. | Service outage could prevent script execution until tokens are manually provided. |
| **Twitter OAuth 1.0a Token Expiry** | Implement detection of 401/403 errors and prompt for re-authorization. | User must manually repeat the OAuth "permission" flow to generate new access token/secret. |
| **Rate Limiting** (Existing) | Implement exponential backoff on 429 errors. Reduce frequency if list is very large. | Script may still be temporarily blocked during high-traffic periods. |

## Post-Implementation Review

Critics unavailable. Treat this plan as unreviewed.

## Metadata

- Status: `UNREVIEWED`
- Rounds used: `2`
- Tiers used: `1, 2`
- Unresolved blocking issues: `1`