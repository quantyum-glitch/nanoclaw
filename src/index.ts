import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ASSISTANT_NAME,
  GMAIL_NOTIFY_TO,
  HOST_AI_ENABLED,
  IDLE_TIMEOUT,
  KIMI_API_KEY,
  KIMI_MODEL,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL_GENERAL,
  OPENROUTER_HISTORY_MAX_CHARS,
  OPENROUTER_HISTORY_MAX_MESSAGES,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { HostRouter } from './ai-providers/host-router.js';
import './channels/index.js';
import {
  ChannelOpts,
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getConversationWindow,
  getDatabaseEngine,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { llmCommandHelpText, parseLlmCommand } from './llm-commands.js';
import {
  formatDebateMessage,
  formatFreeModelsMessage,
  listOpenRouterFreeModels,
  runOpenRouterDebate,
} from './openrouter-debate.js';
import {
  ConversationWindowMessage,
  formatHistoryForFallbackPrompt,
  OpenRouterReplyError,
  runOpenRouterReply,
} from './openrouter-runtime.js';
import {
  _getOpenRouterCircuitStateForTests as getOpenRouterCircuitStateForTests,
  _isOpenRouterCircuitOpenForTests as isOpenRouterCircuitOpenForTests,
  _registerOpenRouterFailureForTests as registerOpenRouterFailureForTests,
  _resetOpenRouterCircuitForTests as resetOpenRouterCircuitForTests,
  getOpenRouterCircuitState,
  isOpenRouterCircuitOpen,
  registerOpenRouterFailure,
  resetOpenRouterFailures,
} from './openrouter-circuit.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { getTwitterSummary, refreshTwitterSummary } from './twitter-summary.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
const hostRouter = new HostRouter();
let assistantMessageCounter = 0;
let containerAvailable = true;
let runtimeChannelOpts: ChannelOpts | null = null;
let whatsappSetupInFlight = false;

const DEFAULT_AI_AGENT_KEY = 'default_ai_agent';
const WHATSAPP_STATUS_FILE = path.join(
  process.cwd(),
  'store',
  'auth-status.txt',
);
const WHATSAPP_SETUP_TIMEOUT_MS = 180_000;

interface GmailOutboundChannel extends Channel {
  sendNewEmail(to: string, subject: string, text: string): Promise<boolean>;
  getAuthenticatedEmailAddress(): string;
}

interface AiAgentOption {
  id: string;
  available: boolean;
  reason: string;
}

/** @internal - exported for testing */
export function _resetOpenRouterCircuitForTests(): void {
  resetOpenRouterCircuitForTests();
}

/** @internal - exported for testing */
export function _registerOpenRouterFailureForTests(reason = 'test'): void {
  registerOpenRouterFailureForTests(reason);
}

/** @internal - exported for testing */
export function _isOpenRouterCircuitOpenForTests(nowMs?: number): boolean {
  return isOpenRouterCircuitOpenForTests(nowMs);
}

/** @internal - exported for testing */
export function _getOpenRouterCircuitStateForTests(): {
  failures: number;
  openUntil: number;
} {
  return getOpenRouterCircuitStateForTests();
}

function stripTrailingCodeCommandFromHistory(
  history: ConversationWindowMessage[],
): ConversationWindowMessage[] {
  if (history.length === 0) return history;
  const copy = [...history];
  const last = copy[copy.length - 1];
  if (last.role !== 'user') return history;
  if (/^([/*])\s*code\b/i.test(last.content.trim())) {
    copy.pop();
    return copy;
  }
  return history;
}

function buildClaudeFallbackPrompt(
  history: ConversationWindowMessage[],
  currentPrompt: string,
): string {
  const contextBlock = formatHistoryForFallbackPrompt(history);
  if (!contextBlock) return currentPrompt;
  return `${contextBlock}\n\nCurrent request:\n${currentPrompt}`;
}

async function sendAndStoreAssistantMessage(
  channel: Channel,
  chatJid: string,
  rawText: string,
): Promise<boolean> {
  const text = formatOutbound(rawText);
  if (!text) return false;

  await channel.sendMessage(chatJid, text);

  const now = new Date().toISOString();
  const unique = assistantMessageCounter++;
  storeMessageDirect({
    id: `assistant-${Date.now()}-${unique}`,
    chat_jid: chatJid,
    sender: 'assistant@nanoclaw.local',
    sender_name: ASSISTANT_NAME,
    content: text,
    timestamp: now,
    is_from_me: true,
    is_bot_message: true,
  });
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGmailOutboundChannel(
  channel: Channel,
): channel is GmailOutboundChannel {
  return (
    channel.name === 'gmail' &&
    typeof (channel as GmailOutboundChannel).sendNewEmail === 'function' &&
    typeof (channel as GmailOutboundChannel).getAuthenticatedEmailAddress ===
      'function'
  );
}

function getDefaultAiAgentPreference(): string {
  const current = getRouterState(DEFAULT_AI_AGENT_KEY)?.trim().toLowerCase();
  return current || 'auto';
}

function setDefaultAiAgentPreference(agent: string): void {
  setRouterState(DEFAULT_AI_AGENT_KEY, agent.trim().toLowerCase());
}

function getAiAgentOptions(): AiAgentOption[] {
  return [
    {
      id: 'claude',
      available: containerAvailable,
      reason: containerAvailable
        ? 'container runtime available'
        : 'container runtime unavailable',
    },
    {
      id: `openrouter/${OPENROUTER_MODEL_GENERAL}`,
      available: OPENROUTER_API_KEY.length > 0,
      reason:
        OPENROUTER_API_KEY.length > 0
          ? 'OPENROUTER_API_KEY configured'
          : 'OPENROUTER_API_KEY missing',
    },
    {
      id: `kimi/${KIMI_MODEL}`,
      available: KIMI_API_KEY.length > 0,
      reason:
        KIMI_API_KEY.length > 0
          ? 'KIMI_API_KEY configured'
          : 'KIMI_API_KEY missing',
    },
    {
      id: `openai/${OPENAI_MODEL}`,
      available: OPENAI_API_KEY.length > 0,
      reason:
        OPENAI_API_KEY.length > 0
          ? 'OPENAI_API_KEY configured'
          : 'OPENAI_API_KEY missing',
    },
  ];
}

function formatAiStatusMessage(): string {
  const defaultAgent = getDefaultAiAgentPreference();
  const lines = ['*AI Agent Status*', ''];
  for (const option of getAiAgentOptions()) {
    const marker = option.available ? 'âœ…' : 'âŒ';
    const suffix = option.id === defaultAgent ? ' [default]' : '';
    lines.push(`${marker} ${option.id}${suffix} â€” ${option.reason}`);
  }
  if (defaultAgent === 'auto') {
    lines.push('â„¹ï¸ auto â€” use built-in routing defaults');
  }
  lines.push('');
  lines.push('Use /ai-use <agent> to switch default.');
  lines.push('Send your next prompt when ready.');
  return lines.join('\n');
}

function normalizeAiAgentChoice(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'auto' || normalized === 'claude') return normalized;
  if (normalized === 'openrouter')
    return `openrouter/${OPENROUTER_MODEL_GENERAL}`;
  if (normalized === 'kimi') return `kimi/${KIMI_MODEL}`;
  if (normalized === 'openai') return `openai/${OPENAI_MODEL}`;
  if (
    normalized.startsWith('openrouter/') ||
    normalized.startsWith('kimi/') ||
    normalized.startsWith('openai/')
  ) {
    return normalized;
  }
  return null;
}

function isAiAgentAvailable(agent: string): boolean {
  if (agent === 'auto') return true;
  return getAiAgentOptions().some(
    (option) => option.id === agent && option.available,
  );
}

function getPreferredHostProvider(
  agent: string,
): 'openrouter' | 'kimi' | 'openai' | null {
  if (!agent.includes('/')) return null;
  const provider = agent.split('/')[0];
  if (
    provider === 'openrouter' ||
    provider === 'kimi' ||
    provider === 'openai'
  ) {
    return provider;
  }
  return null;
}

function isValidPhoneNumber(phone: string): boolean {
  return /^[0-9]{8,15}$/.test(phone.trim());
}

function clearWhatsAppStatusFile(): void {
  try {
    fs.unlinkSync(WHATSAPP_STATUS_FILE);
  } catch {
    // ignore
  }
}

function readWhatsAppStatus(): string {
  try {
    return fs.readFileSync(WHATSAPP_STATUS_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}

async function waitForWhatsAppStatus(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number,
  predicate: (status: string) => boolean,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = readWhatsAppStatus();
    if (status && predicate(status)) return status;
    if (
      proc.exitCode !== null &&
      proc.exitCode !== 0 &&
      status.startsWith('failed:')
    ) {
      return status;
    }
    await sleep(1000);
  }
  throw new Error('whatsapp_auth_timeout');
}

async function connectChannelAtRuntime(
  channelName: string,
  opts?: { forceEnable?: boolean },
): Promise<Channel | null> {
  const existing = channels.find(
    (channel) => channel.name === channelName && channel.isConnected(),
  );
  if (existing) return existing;
  if (!runtimeChannelOpts) {
    logger.error(
      { channelName },
      'Runtime channel options are not initialized',
    );
    return null;
  }

  let channel: Channel | null = null;
  if (channelName === 'whatsapp' && opts?.forceEnable) {
    const mod = await import('./channels/whatsapp.js');
    channel = new mod.WhatsAppChannel(
      runtimeChannelOpts as import('./channels/whatsapp.js').WhatsAppChannelOpts,
    );
  } else {
    const factory = getChannelFactory(channelName);
    if (!factory) return null;
    channel = factory(runtimeChannelOpts);
  }

  if (!channel) return null;

  try {
    await channel.connect();
  } catch (err) {
    logger.warn({ channelName, err }, 'Runtime channel connection failed');
    return null;
  }

  if (!channel.isConnected()) {
    logger.warn(
      { channelName },
      'Runtime channel did not reach connected state',
    );
    return null;
  }

  channels.push(channel);
  logger.info({ channelName }, 'Runtime channel connected');
  return channel;
}

async function startWhatsAppPairingSetup(
  requestChannel: Channel,
  chatJid: string,
  phone: string,
): Promise<void> {
  if (whatsappSetupInFlight) {
    await sendAndStoreAssistantMessage(
      requestChannel,
      chatJid,
      'WhatsApp setup is already in progress. Please wait for completion.',
    );
    return;
  }

  whatsappSetupInFlight = true;
  clearWhatsAppStatusFile();

  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const authProc = spawn(
    npxBin,
    ['tsx', 'src/whatsapp-auth.ts', '--pairing-code', '--phone', phone.trim()],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  authProc.stdout?.on('data', (chunk) => {
    logger.debug({ output: String(chunk).trim() }, 'whatsapp-auth stdout');
  });
  authProc.stderr?.on('data', (chunk) => {
    logger.warn({ output: String(chunk).trim() }, 'whatsapp-auth stderr');
  });

  try {
    await sendAndStoreAssistantMessage(
      requestChannel,
      chatJid,
      'Starting WhatsApp setup. Generating pairing code now...',
    );

    const pairingStatus = await waitForWhatsAppStatus(
      authProc,
      30_000,
      (status) =>
        status.startsWith('pairing_code:') ||
        status === 'already_authenticated' ||
        status.startsWith('failed:'),
    );

    if (pairingStatus.startsWith('failed:')) {
      await sendAndStoreAssistantMessage(
        requestChannel,
        chatJid,
        `WhatsApp setup failed: ${pairingStatus.replace('failed:', '')}. Try /enable-whatsapp <phone> again.`,
      );
      return;
    }

    if (pairingStatus.startsWith('pairing_code:')) {
      const code = pairingStatus.replace('pairing_code:', '');
      await sendAndStoreAssistantMessage(
        requestChannel,
        chatJid,
        `Pairing code: ${code}\nOpen WhatsApp â†’ Linked Devices â†’ Link with phone number and enter this code.`,
      );
    } else {
      await sendAndStoreAssistantMessage(
        requestChannel,
        chatJid,
        'WhatsApp was already authenticated. Connecting channel now...',
      );
    }

    const finalStatus = await waitForWhatsAppStatus(
      authProc,
      WHATSAPP_SETUP_TIMEOUT_MS,
      (status) =>
        status === 'authenticated' ||
        status === 'already_authenticated' ||
        status.startsWith('failed:'),
    );

    if (finalStatus.startsWith('failed:')) {
      await sendAndStoreAssistantMessage(
        requestChannel,
        chatJid,
        `WhatsApp pairing failed: ${finalStatus.replace('failed:', '')}. Please retry with /enable-whatsapp <phone>.`,
      );
      return;
    }

    const runtimeChannel = await connectChannelAtRuntime('whatsapp', {
      forceEnable: true,
    });
    if (!runtimeChannel) {
      await sendAndStoreAssistantMessage(
        requestChannel,
        chatJid,
        'WhatsApp was authenticated, but channel activation failed. Restart NanoClaw and try again.',
      );
      return;
    }

    await sendAndStoreAssistantMessage(
      requestChannel,
      chatJid,
      'WhatsApp connected successfully. Send your next prompt.',
    );
  } catch (err) {
    await sendAndStoreAssistantMessage(
      requestChannel,
      chatJid,
      `WhatsApp setup timed out or failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  } finally {
    whatsappSetupInFlight = false;
    if (authProc.exitCode === null) {
      authProc.kill();
    }
  }
}

async function sendStartupHelloEmail(): Promise<void> {
  let gmailChannel: GmailOutboundChannel | null = null;
  for (const channel of channels) {
    if (channel.isConnected() && isGmailOutboundChannel(channel)) {
      gmailChannel = channel;
      break;
    }
  }
  if (!gmailChannel) return;

  const to = GMAIL_NOTIFY_TO || gmailChannel.getAuthenticatedEmailAddress();
  if (!to) {
    logger.warn('Skipping startup hello email: no recipient resolved');
    return;
  }

  const startedAt = new Date().toISOString();
  const host = os.hostname();
  const connectedNames =
    channels.map((channel) => channel.name).join(', ') || 'none';
  const aiOptions = getAiAgentOptions()
    .map((option) => `${option.available ? 'âœ…' : 'âŒ'} ${option.id}`)
    .join('\n');
  const defaultAgent = getDefaultAiAgentPreference();

  const subject = 'NanoClaw is Online âœ“';
  const body = [
    `NanoClaw started successfully on ${host} at ${startedAt}.`,
    '',
    `Connected channels: ${connectedNames}`,
    `Polling interval: ${POLL_INTERVAL} ms`,
    `Container runtime: ${containerAvailable ? 'available' : 'unavailable'}`,
    'Status: Active and monitoring inbox',
    '',
    'Available AI agents:',
    aiOptions,
    '',
    `Current default: ${defaultAgent}`,
    'Use /ai-status and /ai-use <agent> to manage.',
    'Use /enable-whatsapp <phone> to pair WhatsApp.',
    '',
    'Reply with your next prompt.',
  ].join('\n');

  const sent = await gmailChannel.sendNewEmail(to, subject, body);
  if (!sent) {
    logger.warn({ to }, 'Startup hello email failed to send');
  }
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Advance cursor so messages are marked handled before command/container work.
  // Save old cursor so we can roll back if processing fails before any output.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  const latestMessage = missedMessages[missedMessages.length - 1];
  const llmCommand = parseLlmCommand(latestMessage.content, TRIGGER_PATTERN);
  let codePromptOverride: string | undefined;
  let forceContainer = false;
  if (llmCommand) {
    try {
      if (llmCommand.type === 'help') {
        await sendAndStoreAssistantMessage(
          channel,
          chatJid,
          llmCommandHelpText(),
        );
        return true;
      }

      if (llmCommand.type === 'list-free-models') {
        await sendAndStoreAssistantMessage(
          channel,
          chatJid,
          'Checking current free OpenRouter models...',
        );
        const models = await listOpenRouterFreeModels(20);
        await sendAndStoreAssistantMessage(
          channel,
          chatJid,
          formatFreeModelsMessage(models),
        );
        return true;
      }

      if (llmCommand.type === 'debate') {
        await sendAndStoreAssistantMessage(
          channel,
          chatJid,
          'Running multi-model critique/fight now. This can take up to ~90 seconds.',
        );
        const debate = await runOpenRouterDebate(llmCommand.prompt);
        await sendAndStoreAssistantMessage(
          channel,
          chatJid,
          formatDebateMessage(debate),
        );
        return true;
      }

      if (llmCommand.type === 'ai-status') {
        await sendAndStoreAssistantMessage(
          channel,
          chatJid,
          formatAiStatusMessage(),
        );
        return true;
      }

      if (llmCommand.type === 'ai-primary') {
        const current = getDefaultAiAgentPreference();
        await sendAndStoreAssistantMessage(
          channel,
          chatJid,
          `Current default AI agent: ${current}\nUse /ai-use <agent> to change.\nSend your next prompt when ready.`,
        );
        return true;
      }

      if (llmCommand.type === 'ai-use') {
        const selected = normalizeAiAgentChoice(llmCommand.agent);
        if (!selected) {
          await sendAndStoreAssistantMessage(
            channel,
            chatJid,
            'Invalid agent. Use /ai-status to view valid options.',
          );
          return true;
        }
        if (!isAiAgentAvailable(selected)) {
          await sendAndStoreAssistantMessage(
            channel,
            chatJid,
            `Agent "${selected}" is unavailable right now. Use /ai-status for options.`,
          );
          return true;
        }

        setDefaultAiAgentPreference(selected);
        await sendAndStoreAssistantMessage(
          channel,
          chatJid,
          `Default AI agent set to ${selected}. Send your next prompt when ready.`,
        );
        return true;
      }

      if (llmCommand.type === 'enable-whatsapp') {
        if (!isValidPhoneNumber(llmCommand.phone)) {
          await sendAndStoreAssistantMessage(
            channel,
            chatJid,
            'Invalid phone number. Use digits only with country code, e.g. /enable-whatsapp 14155551234',
          );
          return true;
        }
        void startWhatsAppPairingSetup(channel, chatJid, llmCommand.phone);
        return true;
      }

      if (llmCommand.type === 'twitter-summary') {
        await sendAndStoreAssistantMessage(
          channel,
          chatJid,
          getTwitterSummary(),
        );
        return true;
      }

      if (llmCommand.type === 'twitter-refresh') {
        await sendAndStoreAssistantMessage(
          channel,
          chatJid,
          'Refreshing Twitter summary...',
        );
        const summary = await refreshTwitterSummary();
        await sendAndStoreAssistantMessage(channel, chatJid, summary);
        return true;
      }

      if (llmCommand.type === 'agent') {
        codePromptOverride = llmCommand.prompt;
        forceContainer = true;
      } else {
        codePromptOverride = llmCommand.prompt;
      }
    } catch (err) {
      logger.error({ chatJid, err }, 'LLM command failed');
      await sendAndStoreAssistantMessage(
        channel,
        chatJid,
        `LLM command failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }

  const prompt = codePromptOverride || formatMessages(missedMessages, TIMEZONE);
  const rawHistory = getConversationWindow(
    chatJid,
    OPENROUTER_HISTORY_MAX_MESSAGES,
    OPENROUTER_HISTORY_MAX_CHARS,
  );
  const history = codePromptOverride
    ? stripTrailingCodeCommandFromHistory(rawHistory)
    : rawHistory;

  const preferredAgent = getDefaultAiAgentPreference();
  if (!forceContainer && !codePromptOverride && preferredAgent !== 'auto') {
    if (preferredAgent === 'claude') {
      if (containerAvailable) {
        forceContainer = true;
      } else {
        logger.warn(
          { chatJid },
          'Preferred agent is claude but container is unavailable',
        );
      }
    } else {
      const preferredProvider = getPreferredHostProvider(preferredAgent);
      if (preferredProvider) {
        try {
          const preferredRouter = new HostRouter({
            primary: preferredProvider,
            fallbackChain: [],
          });
          const groupDir = resolveGroupFolderPath(group.folder);
          const preferredResult = await preferredRouter.route({
            prompt,
            messages: history,
            groupName: group.name,
            channelName: channel.name,
            groupMemoryPath: path.join(groupDir, 'CLAUDE.md'),
            globalMemoryPath: path.join(
              process.cwd(),
              'groups',
              'global',
              'CLAUDE.md',
            ),
            assistantName: ASSISTANT_NAME,
          });
          if (preferredResult) {
            await sendAndStoreAssistantMessage(
              channel,
              chatJid,
              preferredResult.text,
            );
            return true;
          }
        } catch (err) {
          logger.warn(
            {
              chatJid,
              preferredAgent,
              err: err instanceof Error ? err.message : String(err),
            },
            'Preferred AI attempt failed, falling back to normal routing',
          );
        }
      }
    }
  }

  if (HOST_AI_ENABLED && !forceContainer && !codePromptOverride) {
    try {
      const groupDir = resolveGroupFolderPath(group.folder);
      const hostResult = await hostRouter.route({
        prompt,
        messages: history,
        groupName: group.name,
        channelName: channel.name,
        groupMemoryPath: path.join(groupDir, 'CLAUDE.md'),
        globalMemoryPath: path.join(
          process.cwd(),
          'groups',
          'global',
          'CLAUDE.md',
        ),
        assistantName: ASSISTANT_NAME,
      });
      if (hostResult) {
        await sendAndStoreAssistantMessage(channel, chatJid, hostResult.text);
        return true;
      }
      logger.info(
        { chatJid },
        'All host providers failed, falling through to container',
      );
    } catch (err) {
      logger.warn(
        {
          chatJid,
          err: err instanceof Error ? err.message : String(err),
        },
        'Host router failed, falling through to container',
      );
    }
  } else if (!forceContainer) {
    const useOpenRouter = OPENROUTER_API_KEY.length > 0;
    const circuitOpen = isOpenRouterCircuitOpen();
    if (useOpenRouter && !circuitOpen) {
      try {
        const groupDir = resolveGroupFolderPath(group.folder);
        const openRouterResult = await runOpenRouterReply({
          groupName: group.name,
          channelName: channel.name,
          history,
          promptOverride: prompt,
          forceCodeModel: Boolean(codePromptOverride),
          groupMemoryPath: path.join(groupDir, 'CLAUDE.md'),
          globalMemoryPath: path.join(
            process.cwd(),
            'groups',
            'global',
            'CLAUDE.md',
          ),
        });
        await sendAndStoreAssistantMessage(
          channel,
          chatJid,
          openRouterResult.text,
        );
        resetOpenRouterFailures();
        return true;
      } catch (err) {
        if (err instanceof OpenRouterReplyError && err.kind !== 'config') {
          registerOpenRouterFailure(err.kind);
        }
        const circuitState = getOpenRouterCircuitState();
        logger.warn(
          {
            chatJid,
            err: err instanceof Error ? err.message : String(err),
            openRouterConsecutiveFailures: circuitState.failures,
            circuitOpenUntil:
              circuitState.openUntil > 0
                ? new Date(circuitState.openUntil).toISOString()
                : null,
          },
          'OpenRouter host-side reply failed, falling back to Claude container',
        );
      }
    } else if (useOpenRouter && circuitOpen) {
      const circuitState = getOpenRouterCircuitState();
      logger.info(
        { chatJid, openRouterCircuitOpenUntil: circuitState.openUntil },
        'OpenRouter circuit is open, routing directly to Claude fallback',
      );
    }
  }

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages via Claude fallback container',
  );

  if (!containerAvailable) {
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    await sendAndStoreAssistantMessage(
      channel,
      chatJid,
      'Container runtime is unavailable and host providers failed. Please retry after fixing runtime or changing /ai-use.',
    );
    return false;
  }

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  const fallbackPrompt = buildClaudeFallbackPrompt(history, prompt);

  const output = await runAgent(
    group,
    fallbackPrompt,
    chatJid,
    async (result) => {
      // Streaming output callback â€” called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks â€” agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          outputSentToUser = await sendAndStoreAssistantMessage(
            channel,
            chatJid,
            text,
          );
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor â€”
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    try {
      await sendAndStoreAssistantMessage(
        channel,
        chatJid,
        'I could not generate a reply right now. Please retry in a moment.',
      );
    } catch (notifyErr) {
      logger.warn({ chatJid, notifyErr }, 'Failed to send dual-failure notice');
    }
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const latestPendingMessage =
            messagesToSend[messagesToSend.length - 1];
          const pendingCommand = parseLlmCommand(
            latestPendingMessage.content,
            TRIGGER_PATTERN,
          );
          if (pendingCommand) {
            // Force command handling through processGroupMessages (host-side),
            // even if a container is currently active for this group.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // Always route through processGroupMessages so host-side OpenRouter
          // decision logic is applied consistently.
          queue.enqueueMessageCheck(chatJid);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  try {
    ensureContainerSystemRunning();
    containerAvailable = true;
  } catch (err) {
    containerAvailable = false;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Container runtime unavailable: continuing in host-only mode',
    );
  }
  initDatabase();
  logger.info(
    {
      dbEngine: getDatabaseEngine(),
      pid: process.pid,
      platform: process.platform,
      nodeVersion: process.version,
    },
    'Database initialized',
  );
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts: ChannelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };
  runtimeChannelOpts = channelOpts;

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing â€” skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    try {
      await channel.connect();
      if (!channel.isConnected()) {
        logger.warn(
          { channel: channelName },
          'Channel did not reach connected state â€” skipping',
        );
        continue;
      }
      channels.push(channel);
    } catch (err) {
      logger.warn(
        {
          channel: channelName,
          err: err instanceof Error ? err.message : String(err),
        },
        'Channel connect failed â€” continuing with other channels',
      );
    }
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }
  logger.info(
    {
      channels: channels.map((channel) => channel.name),
      channelCount: channels.length,
    },
    'Channels connected',
  );

  await sendStartupHelloEmail();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      await sendAndStoreAssistantMessage(channel, jid, rawText);
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      await sendAndStoreAssistantMessage(channel, jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
