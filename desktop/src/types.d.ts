/** Bridge surface exposed by electron/preload.cjs. */

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export interface DevicePollResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

export interface BenchFinding {
  turnId: string | null;
  line: number;
  speaker?: string;
  ts: string | null;
  flag: string;
  reason: string;
}

export interface BenchReport {
  schema: string;
  repo: string;
  branch: string;
  benchmark: string;
  benchmarkTitle: string;
  benchmarkDescription: string;
  startedAt: string;
  finishedAt: string;
  runner?: { kind: 'daytona' | 'local' | 'rocketride'; sandboxId?: string };
  summary: {
    sessions: number;
    turns: number;
    parseErrors: number;
    flagged: number;
    score: number;
    [k: string]: number;
  };
  perSession: { sid: string | null; label: string; turns: number; flagged: number }[];
  findings: BenchFinding[];
}

export interface ApiResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

export interface DesktopBridge {
  deviceStart(clientId: string): Promise<DeviceCodeResponse>;
  devicePoll(clientId: string, deviceCode: string): Promise<DevicePollResponse>;
  apiFetch(method: string, path: string, token: string, body?: unknown): Promise<ApiResponse>;
  runBench(params: {
    repo: string;
    benchmark: string;
    branch?: string;
    runner?: 'daytona' | 'local' | 'rocketride';
    daytonaApiKey?: string;
    rocketrideApiKey?: string;
    rocketrideUri?: string;
  }): Promise<BenchReport>;
  saveReport(report: BenchReport): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  onBenchProgress(cb: (message: string) => void): () => void;
}

declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
