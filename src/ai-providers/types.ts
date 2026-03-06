import { ConversationWindowMessage } from '../openrouter-runtime.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateParams {
  prompt: string;
  messages: ConversationWindowMessage[];
  systemPrompt: string;
  temperature?: number;
  timeoutMs?: number;
  forceCodeModel?: boolean;
}

export interface GenerateResult {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  tokensUsed?: { prompt: number; completion: number };
}

export interface HostProvider {
  readonly name: string;
  readonly model: string;
  isAvailable(): boolean;
  generate(params: GenerateParams): Promise<GenerateResult>;
}
