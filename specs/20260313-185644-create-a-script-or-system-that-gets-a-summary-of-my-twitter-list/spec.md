# Spec: create a script or system that gets a summary of my twitter list and sends it to my gmail every hour

> [!WARNING]
> UNREVIEWED: critics were unavailable or timed out. Human review required.

## Summary
A lightweight, hourly‑running service that (1) authenticates to the Twitter API v2, (2) pulls the members of a specified Twitter List, (3) builds a concise summary (list name, member count, and the 5 most recent tweets from those members), and (4) emails that summary to a Gmail address via the Gmail REST API (or SMTP as a fallback). The service can be deployed as a containerized cron job (e.g., on AWS ECS Fargate with EventBridge Scheduler, GCP Cloud Run with Cloud Scheduler, or a simple Linux cron on a VM).

## Architecture
```
+-------------------+        +-------------------+        +-------------------+
|  Scheduler (cron/ | --->   |  Worker Service   | --->   |  Gmail API / SMTP |
|  EventBridge/    |        |  (Python 3.11)    |        |  (OAuth2 token)   |
|  Cloud Scheduler) |        +-------------------+        +-------------------+
        ^                         ^                           ^
        |                         |                           |
        |                         |                           |
        |                         v                           v
        |               +-------------------+        +-------------------+
        |               |  Twitter API v2   |        |  Secret Store     |
        |               |  (Bearer token)   |        |  (AWS SSM / GCP   |
        |               +-------------------+        |  Secret Manager)  |
        |                                            +-------------------+
        |
        +--- (Optional) Monitoring & Alerting (CloudWatch / Stackdriver)
```

**Components**

| Component | Responsibility | Tech Choices | Why |
|-----------|----------------|--------------|-----|
| Scheduler | Triggers the worker every hour | • Linux `cron` (VM)  <br>• AWS EventBridge Scheduler + ECS Fargate <br>• GCP Cloud Scheduler + Cloud Run | Simple, reliable, server‑less options avoid managing a long‑running process. |
| Worker Service | Auth → fetch list → summarize → email | Python 3.11, `requests-oauthlib` for OAuth2, `tweepy` (v4) for Twitter v2, `google-api-python-client` for Gmail, `python-dotenv` for config | Mature libraries, good docs, easy to unit‑test. |
| Secret Store | Holds Twitter Bearer token, Gmail OAuth2 refresh token, list ID | AWS Systems Manager Parameter Store (encrypted) **or** GCP Secret Manager **or** encrypted `.env` file (local dev) | Keeps credentials out of source control; rotation is straightforward. |
| Monitoring / Alerting (optional) | Log execution, detect failures | CloudWatch Logs + Metric Filter (AWS) or Stackdriver Logging + Alerting (GCP) or simple `logger` + `sentry-sdk` | Provides visibility into throttling, auth errors, email send failures. |

**Data Flow (per hour)**  

1. Scheduler invokes the worker container (or cron runs the script).  
2. Worker loads secrets, builds an OAuth2 Bearer token for Twitter v2.  
3. Calls `GET /2/lists/{list_id}/members` → receives list of user IDs (paginated, respecting `max_results=100`).  
4. For each member (or a sample if >1000 members to stay within rate limits), calls `GET /2/users/{id}/tweets` with `max_results=5` and `tweet.fields=created_at,public_metrics`.  
5. Aggregates:  
   - List name (cached from `GET /2/lists/{list_id}`)  
   - Total member count  
   - Top 5 most recent tweets across all members (sorted by `created_at`).  
6. Formats a plain‑text (or minimal HTML) email body.  9. Uses Gmail API (`users.messages.send`) with a pre‑authorized OAuth2 refresh token to send the email to the target Gmail address.  
10. Logs success/failure and exits (container stops).  

---

## Implementation Changes

### File Tree (new/modified)

```
twitter-list-summary/
├── src/
│   ├── __init__.py
│   ├── worker.py          # main entry point
│   ├── twitter_client.py  # thin wrapper around Twitter v2 endpoints
│   ├── gmail_client.py    # Gmail API wrapper (fallback to smtplib)
│   └── config.py          # loads env vars / secret store
├── tests/
│   ├── test_twitter_client.py
│   ├── test_gmail_client.py
│   └── test_worker.py
├── Dockerfile             # builds a slim python:3.11-slim image
├── .github/
│   └── workflows/
│       └── ci.yml         # GitHub Actions: lint, unit test, build image
├── requirements.txt
├── README.md              # updated with deployment instructions
└── .env.example           # example of local env vars (not committed)
```

### Key Code Snippets

**config.py** (loads from env or secret store)

```python
import os
from typing import Optional

def get_env(name: str, default: Optional[str] = None) -> str:
    val = os.getenv(name, default)
    if val is None:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return val

TWITTER_BEARER_TOKEN = get_env("TWITTER_BEARER_TOKEN")
GMAIL_REFRESH_TOKEN   = get_env("GMAIL_REFRESH_TOKEN")
GMAIL_CLIENT_ID       = get_env("GMAIL_CLIENT_ID")
GMAIL_CLIENT_SECRET   = get_env("GMAIL_CLIENT_SECRET")
TARGET_LIST_ID        = get_env("TARGET_LIST_ID")
TARGET_GMAIL_ADDRESS  = get_env("TARGET_GMAIL_ADDRESS")
```

**twitter_client.py** (handles pagination & rate‑limit back‑off)

```python
import time
import requests
from typing import List, Dict
from .config import TWITTER_BEARER_TOKEN

BASE_URL = "https://api.twitter.com/2"
HEADERS = {"Authorization": f"Bearer {TWITTER_BEARER_TOKEN}"}

def _get_with_retry(url: str, params: dict = None, max_retries: int = 3) -> dict:
    for attempt in range(max_retries):
        resp = requests.get(url, headers=HEADERS, params=params, timeout=10)
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code in (429, 500, 502, 503):
            wait = 2 ** attempt  # exponential backoff
            time.sleep(wait)
            continue
        resp.raise_for_status()
    raise RuntimeError(f"Failed after {max_retries} attempts: {resp.text}")

def get_list_members(list_id: str) -> List[str]:
    """Return a list of user IDs (handles pagination)."""
    url = f"{BASE_URL}/lists/{list_id}/members"
    members = []
    pagination_token = None
    while True:
        params = {"max_results": 100}
        if pagination_token:
            params["pagination_token"] = pagination_token
        data = _get_with_retry(url, params)
        members.extend([u["id"] for u in data.get("data", [])])
        pagination_token = data.get("meta", {}).get("next_token")
        if not pagination_token:
            break
    return members

def get_recent_tweets(user_id: str, limit: int = 5) -> List[Dict]:
    url = f"{BASE_URL}/users/{user_id}/tweets"
    params = {
        "max_results": min(limit, 100),
        "tweet.fields": "created_at,public_metrics",
    }
    data = _get_with_retry(url, params)
    return data.get("data", [])
```

**gmail_client.py** (primary: Gmail API; fallback: SMTP)

```python
import base64
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import smtplib
import ssl
from .config import (
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN,
    TARGET_GMAIL_ADDRESS,
)

SCOPES = ["https://www.googleapis.com/auth/gmail.send"]

def _get_gmail_service():
    creds = Credentials(
        token=None,
        refresh_token=GMAIL_REFRESH_TOKEN,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=GMAIL_CLIENT_ID,
        client_secret=GMAIL_CLIENT_SECRET,
        scopes=SCOPES,
    )
    return build("gmail", "v1", credentials=creds)

def send_via_api(subject: str, body: str):
    service = _get_gmail_service()
    message = MIMEMultipart()
    message["to"] = TARGET_GMAIL_ADDRESS
    message["from"] = "me"
    message["subject"] = subject
    message.attach(MIMEText(body, "plain"))
    raw = base64.urlsafe64encode(message.as_bytes()).decode()
    service.users().messages().send(userId="me", body={"raw": raw}).execute()

def send_via_smtp(subject: str, body: str):
    # Uses App Password or less‑secure‑app fallback; only for dev/test
    context = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context) as server:
        server.login(TARGET_GMAIL_ADDRESS, os.getenv("GMAIL_APP_PASSWORD"))
        msg = MIMEText(body, "plain")
        msg["Subject"] = subject
        msg["From"] = TARGET_GMAIL_ADDRESS
        msg["To"] = TARGET_GMAIL_ADDRESS
        server.send_message(msg)

def send_email(subject: str, body: str):
    try:
        send_via_api(subject, body)
    except Exception as e:  # pragma: no cover – fallback path
        # Log and try SMTP as a last resort
        send_via_smtp(subject, body)
```

**worker.py** (orchestration)

```python
import logging
from datetime import datetime, timezone
from .config import TARGET_LIST_ID, TARGET_GMAIL_ADDRESS
from .twitter_client import get_list_members, get_recent_tweets
from .gmail_client import send_email

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

def build_summary(list_name: str, member_count: int, tweets: list) -> str:
    lines = [
        f"Twitter List Summary – {list_name}",
        f"Generated at {datetime.now(timezone.utc).isoformat()} UTC",
        f"- Members: {member_count}",
        f"- Recent tweets (top {len(tweets)}):",
    ]
    for tw in tweets:
        author_id = tw.get("author_id", "unknown")
        text = tw["text"].replace("\n", " ")
        created = tw["created_at"]
        lines.append(f"  • [{created}] @{author_id}: {text}")
    return "\n".join(lines)

def main():
    try:
        # 1️⃣ Get list metadata (name)
        list_meta_url = f"https://api.twitter.com/2/lists/{TARGET_LIST_ID}"
        list_meta = requests.get(list_meta_url, headers={"Authorization": f"Bearer {TWITTER_BEARER_TOKEN}"}).json()
        list_name = list_meta.get("data", {}).get("name", TARGET_LIST_ID)

        # 2️⃣ Fetch members
        member_ids = get_list_members(TARGET_LIST_ID)
        logging.info(f"Fetched {len(member_ids)} members from list '{list_name}'")

        # 3️⃣ Gather recent tweets (limit to first 50 members to stay under rate limits)
        MAX_MEMBERS_TO_SCAN = 50
        sampled_ids = member_ids[:MAX_MEMBERS_TO_SCAN]
        all_tweets = []
        for uid in sampled_ids:
            tweets = get_recent_tweets(uid, limit=5)
            all_tweets.extend(tweets)

        # Sort by timestamp descending and keep top 5
        all_tweets.sort(key=lambda t: t["created_at"], reverse=True)
        top_tweets = all_tweets[:5]

        # 4️⃣ Build & send email
        summary = build_summary(list_name, len(member_ids), top_tweets)
        subject = f"[Twitter List] {list_name} – Hourly Summary"
        send_email(subject, summary)
        logging.info("Summary email sent successfully")
    except Exception as exc:  # pragma: no cover
        logging.exception("Worker failed")
        raise

if __name__ == "__main__":
    main()
```

**Dockerfile** (minimal, production‑ready)

```dockerfile
FROM python:3.11-slim

# Install runtime dependencies (ca-certificates for HTTPS, libffi for cryptography)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libffi-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY .env.example .env.example   # for reference; not copied into image

ENTRYPOINT ["python", "-m", "src.worker"]
```

**CI/CD snippet (GitHub Actions)** – builds image, runs unit tests, pushes to ECR/GCR.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - name: Install deps
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt
          pip install pytest pytest-mock
      - name: Run tests
        run: pytest -q
      - name: Build Docker image
        run: |
          docker build -t twitter-list-summary:${{ github.sha }} .
      # (Optional) push to registry, deploy to ECS/Fargate or Cloud Run
```

---

## Test Plan

| Test Type | Scope | Tools / Mocks | Acceptance Criteria |
|-----------|-------|---------------|---------------------|
| **Unit** | `twitter_client.get_list_members` pagination handling | `responses` library to mock HTTP calls; simulate 2 pages + empty next_token | Returns concatenated list of IDs; handles missing `meta.next_token`. |
| **Unit** | `twitter_client.get_recent_tweets` rate‑limit back‑off | `responses` with 429 then 200; verify sleep called (via `time.sleep` patch) | Retries up to 3 times, returns tweet list after success. |
| **Unit** | `gmail_client.send_via_api` | `googleapiclient.discovery.build` mocked; assert `users().messages().send` called with correct raw payload | Email sent via API when credentials valid. |
| **Unit** | `gmail_client.send_via_smtp` (fallback) | `smtplib.SMTP_SSL` mocked; assert `login` and `send_message` called | Falls back to SMTP when API raises exception. |
| **Unit** | `worker.build_summary` | Provide deterministic tweet list; check ordering and formatting | Output contains list name, member count, and exactly 5 tweet lines sorted newest→oldest. |
| **Integration** (local) | End‑to‑end flow with fake Twitter & Gmail servers | Use `httpretty` or `responses` to mock all external HTTP; invoke `worker.main()` | No exceptions; logs show “Summary email sent successfully”. |
| **System** (staging) | Deploy to a dev environment (ECS Fargate or Cloud Run) with a test list & a dedicated Gmail account | Real Twitter API (sandbox‑like: use a dev‑only bearer token with limited scope) and real Gmail OAuth2 refresh token | Hourly trigger receives email; verify content matches expected format; verify no duplicate emails if scheduler misfires. |
| **Chaos** | Simulate network failure, 429, 500, token expiry | Inject faults via `toxiproxy` or by pointing to a mock server that returns errors | Worker logs error, exits with non‑zero code; scheduler retries (depends on platform) – no infinite loop. |
| **Load** | List with 5000 members (worst‑case) | Use a mock Twitter endpoint that returns 100 members per page; verify worker respects `MAX_MEMBERS_TO_SCAN` and does not exceed Twitter rate limits (≈900 requests/15 |

---

## Risks

| ID | Severity | Description | Mitigation |
|:---|:---|:---|:---|
| B1 | BLOCKING | Authentication to the Twitter API v2 using a Bearer token is critical for the script to function.  Failure to authenticate will prevent fetching list members and tweets. | Implement robust OAuth2 flow with proper token management and error handling.  Use a secure secret store. |
| B2 | BLOCKING | The script relies on pagination to retrieve all members of the Twitter List.  Without correct handling of the `pagination_token`, the script will not retrieve all members, leading to an incomplete summary. | Implement pagination logic correctly, handling the `pagination_token` and retrying if necessary.  Add error handling for pagination failures. |
| B3 | BLOCKING | The script fetches tweets from each member individually. Twitter API rate limits are a significant concern.  Exceeding rate limits will cause the script to fail. | Implement rate limit handling (exponential backoff) within the `get_recent_tweets` function.  Limit the number of members scanned per hour. |
| B4 | BLOCKING | Sending emails via the Gmail API requires a valid OAuth2 refresh token.  If the refresh token is invalid or expired, the script will fail to send emails. | Implement a secure mechanism for storing and rotating the Gmail OAuth2 refresh token.  Handle refresh token expiration gracefully. |
| B5 | MINOR | The script currently only fetches the 5 most recent tweets.  This might not be the most informative summary for the list owner. | Consid

[TRUNCATED]

## Post-Implementation Review

Critics unavailable. Treat this plan as unreviewed.

## Metadata

- Status: `UNREVIEWED`
- Rounds used: `2`
- Tiers used: `1`