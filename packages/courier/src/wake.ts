/** What the watcher hands a wake adapter: one thread, every message not yet woken for. */
export interface WakeMessage {
  messageId: string;
  intent: string;
  /** ISO time decoded from the message ULID (the sender's clock). */
  sentAt: string;
}

export interface WakeRequest {
  peer: string;
  threadId: string;
  subject: string;
  messages: WakeMessage[];
}

/** Resolves once the agent has been woken; a rejection keeps the wake pending for retry. */
export type Waker = (request: WakeRequest) => Promise<void>;

export type WatchLog = (event: string, fields?: Record<string, unknown>) => void;

/** One JSON object per line on stdout: the watcher log. */
export function jsonLineLog(write: (line: string) => void = (line) => process.stdout.write(line)): WatchLog {
  return (event, fields = {}) => write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

/** `--wake none`: deliver and mirror, wake nobody. The `woke` log line still records when a wake would fire. */
export const noWaker: Waker = async () => {};
