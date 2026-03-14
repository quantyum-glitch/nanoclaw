# Spec: create a script or system that gets a summary of my twitter list and sends it to my gmail every hour

> [!TIP]
> REVIEWED: no unresolved blocking issues were detected in the configured flow.

## Summary  
This system automates the retrieval of a Twitter list summary and sends it to the user's Gmail every hour. It uses the Twitter API to fetch list data, processes it into a structured summary (e.g., list name, member count, recent activity), and delivers it via the Gmail API. The system is designed to run as a scheduled task (e.g., cron job) with error handling for API rate limits, network failures, and invalid credentials.  

---

## Architecture  
The system is divided into four core components:  

1. **Twitter API Client**  
   - Fetches the user's Twitter list data using the Twitter API v2.  
   - Uses OAuth 2.0 authentication with a bearer token or API key.  
   - Endpoint: `GET /2/lists/members` (or similar, depending on list type).  

2. **Summary Processor**  
   - Parses the Twitter list data into a markdown-formatted summary.  
   - Includes:  
     - List name and description.  
     - Member count and growth rate (if applicable).  
     - Recent tweets from list members (e.g., last 24 hours).  
     - Top contributors (based on tweet volume).  

3. **Gmail API Client**  
   - Sends the summary as an email using the Gmail API.  
   - Uses OAuth 2.0 with a service account or user credentials.  
   - Email subject: `Twitter List Summary - [List Name]`.  

4. **Scheduler**  
   - Triggers the script every hour using a cron job or a lightweight scheduler (e.g., Python's `schedule` library).  
   - Includes a lock file to prevent overlapping executions.  

**Dependencies**:  
- Python 3.8+  
- Libraries: `tweepy`, `google-api-python-client`, `schedule`, `logging`.  

---

## Implementation Changes  
### 1. **Authentication**  
   - **Twitter API**: Store credentials in environment variables (e.g., `TWITTER_BEARER_TOKEN`).  
   - **Gmail API**: Use a service account with domain-wide delegation or a user-specific OAuth2 token.  

### 2. **Script Structure**  
   ```python
   import tweepy
   from googleapiclient.discovery import build
   import schedule
   import time
   import logging

   # Initialize APIs
   auth = tweepy.OAuthHandler(consumer_key, consumer_secret)
   auth.set_access_token(access_token, access_token_secret)
   api = tweepy.API(auth)

   gmail_service = build('gmail', 'v1', credentials=gmail_credentials)

   def fetch_twitter_list():
       # Fetch list members and recent tweets
       # Return structured data

   def generate_summary(data):
       # Convert data to markdown
       return "# Twitter List Summary\n\n" + ... 

   def send_email(summary):
       # Use Gmail API to send email

   def main():
       try:
           data = fetch_twitter_list()
           summary = generate_summary(data)
           send_email(summary)
       except Exception as e:
           logging.error(f"Failed to send summary: {e}")

   if __name__ == "__main__":
       schedule.every().hour.do(main)
       while True:
           schedule.run_pending()
           time.sleep(60)
   ```

### 3. **Rate Limit Handling**  
   - Twitter API has strict rate limits (e.g., 450 requests/15 minutes for academic tracks).  
   - Implement exponential backoff for retries.  
   - Cache list data locally (e.g., JSON file) to avoid redundant API calls.  

### 4. **Error Handling**  
   - Log failures to a file (e.g., `twitter_summary.log`).  
   - Send a failure alert email if the script crashes.  

---

## Test Plan  
### 1. **Unit Tests**  
   - **Twitter API Client**:  
     - Mock responses for `GET /2/lists/members` to test data parsing.  
     - Test edge cases (e.g., empty list, invalid credentials).  
   - **Summary Processor**:  
     - Validate markdown formatting with sample data.  
     - Test growth rate calculation with varying member counts.  
   - **Gmail API Client**:  
     - Mock SMTP server to verify email sending.  

### 2. **Integration Tests**  
   - Run the full script in a test environment with a dummy Twitter list.  
   - Verify that the email is received within 1 hour.  

### 3. **Edge Case Testing**  
   - Simulate network failures (e.g., `requests.exceptions.ConnectionError`).  
   - Test with a list that exceeds Twitter's rate limits.  
   - Validate behavior when the Gmail API is unavailable.  

---

## Risks  
### 1. **API Rate Limits**  
   - **Failure Mode**: The script may fail to fetch data if rate limits are exceeded.  
   - **Mitigation**: Cache data locally and implement retry logic with backoff.  

### 2. **Authentication Issues**  
   - **Failure Mode**: Expired or revoked credentials will block the script.  
   - **Mitigation**: Use environment variables and rotate credentials periodically.  

### 3. **Network Instability**  
   - **Failure Mode**: API calls may fail due to connectivity issues.  
   - **Mitigation**: Retry failed requests and log errors for manual intervention.  

### 4. **Data Accuracy**  
   - **Failure Mode**: The summary may not reflect real-time changes if the list is updated frequently.  
   - **Mitigation**: Fetch data at the start of each hour and use a timestamp in the summary.  

### 5. **Scheduling Conflicts**  
   - **Failure Mode**: Overlapping executions if the script takes longer than an hour.  
   - **Mitigation**: Use a lock file or a distributed lock (e.g., Redis) to prevent concurrent runs.  

---

## Tradeoffs  
- **Simplicity vs. Scalability**: Using `schedule` is simple but lacks advanced features (e.g., distributed scheduling).  
- **Caching vs. Freshness**: Caching reduces API calls but may delay updates.  
- **Error Handling vs. Complexity**: Adding retries and logging increases code complexity but improves reliability.  

This implementation balances simplicity with robustness, prioritizing reliability over absolute real-time accuracy.

## Post-Implementation Review

Review loop passed with no unresolved blocking issues.

## Metadata

- Status: `REVIEWED`
- Rounds used: `1`
- Tiers used: `1, 2`