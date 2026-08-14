export type LeakCategory = 'encrypted-block' | 'secret' | 'pii';

export interface LeakFinding {
  category: LeakCategory;
  kind: string;
  line: number;
  preview: string;
  reason: string;
}

export function scanForLeaks(text: string): LeakFinding[];
export function stripEncryptedBlocks(text: string): { text: string; removed: number };
export function redactSecrets(text: string, opts?: { includePii?: boolean }): { text: string; redacted: number };
export function sanitize(
  text: string,
  opts?: { includePii?: boolean },
): { text: string; removed: number; redacted: number };
export function summarize(findings: LeakFinding[]): Record<LeakCategory, number>;
