import fs from 'fs';
import os from 'os';
import path from 'path';

import { OAuth2Client } from 'google-auth-library';
import { gmail_v1, google } from 'googleapis';

type Action = 'send' | 'ask';

interface CliOptions {
  action: Action;
  message: string;
  to: string;
  subject: string;
  timeoutMs: number;
  pollMs: number;
}

interface AuthContext {
  gmail: gmail_v1.Gmail;
  userEmail: string;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run gmail:ctl -- send "/ai-status" --to bot@gmail.com',
    '  npm run gmail:ctl -- ask "Summarize unread tasks" --to bot@gmail.com',
    '',
    'Options:',
    '  --to <email>         Target mailbox monitored by NanoClaw',
    '  --subject <text>     Email subject (default: "NanoClaw Control")',
    '  --timeout <seconds>  Ask-mode timeout (default: 120)',
    '  --poll <seconds>     Ask-mode poll interval (default: 3)',
    '',
    'Env fallback:',
    '  NANOCLAW_GMAIL_TO    Default --to if omitted',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  let action: Action | null = null;
  let to = process.env.NANOCLAW_GMAIL_TO || '';
  let subject = 'NanoClaw Control';
  let timeoutMs = 120_000;
  let pollMs = 3_000;
  const messageParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === '--to') {
      to = argv[++i] || '';
      continue;
    }
    if (arg === '--subject') {
      subject = argv[++i] || subject;
      continue;
    }
    if (arg === '--timeout') {
      const seconds = Number(argv[++i] || '120');
      if (Number.isFinite(seconds) && seconds > 0) {
        timeoutMs = Math.floor(seconds * 1000);
      }
      continue;
    }
    if (arg === '--poll') {
      const seconds = Number(argv[++i] || '3');
      if (Number.isFinite(seconds) && seconds > 0) {
        pollMs = Math.floor(seconds * 1000);
      }
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }

    if (!action && (arg === 'send' || arg === 'ask')) {
      action = arg;
      continue;
    }

    messageParts.push(arg);
  }

  const message = messageParts.join(' ').trim();

  if (!action || !message || !to) {
    console.error(usage());
    process.exit(1);
  }

  return { action, message, to, subject, timeoutMs, pollMs };
}

function ensureCredPath(file: string): string {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  const fullPath = path.join(credDir, file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing Gmail credentials file: ${fullPath}`);
  }
  return fullPath;
}

function createOauthClient(): OAuth2Client {
  const keysPath = ensureCredPath('gcp-oauth.keys.json');
  const tokensPath = ensureCredPath('credentials.json');

  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
  const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
  const clientConfig = keys.installed || keys.web || keys;
  const { client_id, client_secret, redirect_uris } = clientConfig;
  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0],
  );
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
    Object.assign(current, newTokens);
    fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
  });
  return oauth2Client;
}

async function authenticate(): Promise<AuthContext> {
  const oauth2Client = createOauthClient();
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const userEmail = profile.data.emailAddress || '';
  if (!userEmail) throw new Error('Unable to resolve authenticated Gmail address');
  return { gmail, userEmail };
}

function toBase64Url(text: string): string {
  return Buffer.from(text)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendNewEmail(
  gmail: gmail_v1.Gmail,
  fromEmail: string,
  toEmail: string,
  subject: string,
  body: string,
): Promise<{ threadId: string; sentAtMs: number }> {
  const raw = toBase64Url(
    [
      `To: ${toEmail}`,
      `From: ${fromEmail}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n'),
  );

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  const threadId = res.data.threadId;
  if (!threadId) throw new Error('Gmail did not return a threadId');
  return { threadId, sentAtMs: Date.now() };
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return (
    headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())
      ?.value || ''
  );
}

function extractEmailAddress(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m?.[1] || fromHeader).trim().toLowerCase();
}

function extractTextBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8').trim();
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8').trim();
      }
    }
    for (const part of payload.parts) {
      const nested = extractTextBody(part);
      if (nested) return nested;
    }
  }

  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReply(
  gmail: gmail_v1.Gmail,
  threadId: string,
  senderEmail: string,
  sinceMs: number,
  timeoutMs: number,
  pollMs: number,
): Promise<{ from: string; subject: string; body: string }> {
  const deadline = Date.now() + timeoutMs;
  const me = senderEmail.toLowerCase();

  while (Date.now() < deadline) {
    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const messages = (thread.data.messages || [])
      .slice()
      .sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));

    for (const message of messages) {
      const timestamp = Number(message.internalDate || 0);
      if (timestamp < sinceMs) continue;
      const headers = message.payload?.headers;
      const from = getHeader(headers, 'From');
      if (!from) continue;

      const fromEmail = extractEmailAddress(from);
      if (fromEmail === me) continue;

      const body = extractTextBody(message.payload);
      if (!body) continue;

      return {
        from,
        subject: getHeader(headers, 'Subject'),
        body,
      };
    }

    await sleep(pollMs);
  }

  throw new Error(
    `Timed out waiting for NanoClaw reply in thread ${threadId} after ${Math.ceil(
      timeoutMs / 1000,
    )}s`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const { gmail, userEmail } = await authenticate();

  const { threadId, sentAtMs } = await sendNewEmail(
    gmail,
    userEmail,
    opts.to,
    opts.subject,
    opts.message,
  );

  console.log(`Sent command to ${opts.to}`);
  console.log(`Thread: ${threadId}`);

  if (opts.action === 'send') return;

  const reply = await waitForReply(
    gmail,
    threadId,
    userEmail,
    sentAtMs,
    opts.timeoutMs,
    opts.pollMs,
  );

  console.log('');
  console.log(`Reply from: ${reply.from}`);
  console.log(`Subject: ${reply.subject}`);
  console.log('---');
  console.log(reply.body);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`gmail:ctl error: ${message}`);
  process.exit(1);
});
