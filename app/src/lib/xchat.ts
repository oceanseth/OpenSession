/**
 * Client for the xChatHub OpenSession connector (our fork of the extension).
 *
 * The extension's content script on this origin relays tool calls to the
 * WebMCP tools on the user's own x.com tab — DMs never touch our servers.
 * Protocol (window.postMessage, same-origin):
 *   us → ext:  { xchatos: 'hello' } | { xchatos: 'call', id, name, args }
 *   ext → us:  { xchatos: 'status', connected } | { xchatos: 'result', id, result }
 */

export interface XChatStatus {
  /** The extension's content script answered on this page. */
  available: boolean;
  /** An x.com tab is connected behind the extension. */
  connected: boolean;
}

interface McpResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

export interface ConversationRow {
  id: string;
  route: string;
  title: string;
  details: string[];
}

export interface DmMessage {
  from: 'me' | 'them' | 'unknown';
  text: string;
  time?: string | null;
}

type StatusListener = (s: XChatStatus) => void;

export class XChatConnector {
  status: XChatStatus = { available: false, connected: false };
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  private listeners = new Set<StatusListener>();
  private onMessage = (e: MessageEvent) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data as { xchatos?: string; id?: number; result?: McpResult; connected?: boolean };
    if (d?.xchatos === 'status') {
      this.setStatus({ available: true, connected: !!d.connected });
    } else if (d?.xchatos === 'result' && typeof d.id === 'number') {
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      clearTimeout(p.timer);
      const text = d.result?.content?.map((c) => c.text ?? '').join('') ?? '';
      if (d.result?.isError) p.reject(new Error(text || 'tool call failed'));
      else p.resolve(parseMaybeJson(text));
    }
  };

  private helloTimer?: number;
  private onVisible = () => {
    if (!this.status.available && document.visibilityState === 'visible') this.hello();
  };

  constructor() {
    window.addEventListener('message', this.onMessage);
    // The extension's content script may load after us (document_idle) — or
    // we after it. Its load-time beacon covers one direction; retrying hello
    // for a while covers the other, plus tab-refocus for late installs.
    this.hello();
    let tries = 0;
    this.helloTimer = window.setInterval(() => {
      if (this.status.available || ++tries > 20) {
        clearInterval(this.helloTimer);
        return;
      }
      this.hello();
    }, 1500);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private hello(): void {
    window.postMessage({ xchatos: 'hello' }, window.location.origin);
  }

  dispose(): void {
    clearInterval(this.helloTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('message', this.onMessage);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('connector disposed'));
    }
    this.pending.clear();
  }

  onStatus(cb: StatusListener): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => this.listeners.delete(cb);
  }

  private setStatus(s: XChatStatus): void {
    if (s.available === this.status.available && s.connected === this.status.connected) return;
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }

  /** Invoke an xchat_* tool on the user's x.com tab. */
  call<T = unknown>(name: string, args: Record<string, unknown> = {}, timeoutMs = 25_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${name} timed out — is an x.com tab open and visible?`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      window.postMessage({ xchatos: 'call', id, name, args }, window.location.origin);
    });
  }

  /** Ask the extension to open its DM bridge — a small visible x.com popup window. */
  openBridge(): void {
    window.postMessage({ xchatos: 'open-bridge' }, window.location.origin);
  }

  whoami(): Promise<{ handle: string }> {
    return this.call('xchat_whoami');
  }

  async searchConversations(query: string): Promise<ConversationRow[]> {
    const r = await this.call<{ matches?: ConversationRow[]; results?: ConversationRow[] } | ConversationRow[]>(
      'xchat_search_conversations',
      { query },
    );
    if (Array.isArray(r)) return r;
    return r.matches ?? r.results ?? [];
  }

  async readMessages(conversationId?: string): Promise<{ conversationId: string; title: string | null; messages: DmMessage[] }> {
    return this.call('xchat_read_messages', conversationId ? { conversation_id: conversationId } : {});
  }

  async sendMessage(text: string, conversationId?: string): Promise<unknown> {
    return this.call('xchat_send_message', { text, ...(conversationId ? { conversation_id: conversationId } : {}) }, 45_000);
  }
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
