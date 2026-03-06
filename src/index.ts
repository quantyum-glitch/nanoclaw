import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  HOST_AI_ENABLED,
  IDLE_TIMEOUT,
  OPENROUTER_API_KEY,
  OPENROUTER_HISTORY_MAX_CHARS,
  OPENROUTER_HISTORY_MAX_MESSAGES,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import { HostRouter } from './ai-providers/host-router.js';
import './channels/index.js';
import {
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
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // Advance cursor so messages are marked handled before command/container work.
  // Rollback is only needed for combined OpenRouter+container failures.
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

  const prompt = codePromptOverride || formatMessages(missedMessages);
  const rawHistory = getConversationWindow(
    chatJid,
    OPENROUTER_HISTORY_MAX_MESSAGES,
    OPENROUTER_HISTORY_MAX_CHARS,
  );
  const history = codePromptOverride
    ? stripTrailingCodeCommandFromHistory(rawHistory)
    : rawHistory;

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
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
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
    // If we already sent output to the user, don't roll back the cursor —
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
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
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
  ensureContainerSystemRunning();
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
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
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
