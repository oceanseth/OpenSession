import { describe, expect, it } from 'vitest';
import { parseRepoInput } from './registry';

describe('parseRepoInput', () => {
  it('accepts owner/name', () => {
    expect(parseRepoInput('oceanseth/OpenSession')).toBe('oceanseth/OpenSession');
  });

  it('accepts github URLs, with paths and .git suffixes', () => {
    expect(parseRepoInput('https://github.com/oceanseth/OpenSession')).toBe('oceanseth/OpenSession');
    expect(parseRepoInput('https://github.com/oceanseth/OpenSession/tree/main/app')).toBe('oceanseth/OpenSession');
    expect(parseRepoInput('https://github.com/oceanseth/OpenSession.git')).toBe('oceanseth/OpenSession');
    expect(parseRepoInput('http://github.com/a/b?tab=readme')).toBe('a/b');
  });

  it('trims whitespace', () => {
    expect(parseRepoInput('  a/b  ')).toBe('a/b');
  });

  it('allows dots and dashes in names', () => {
    expect(parseRepoInput('my-org/repo.name-2')).toBe('my-org/repo.name-2');
  });

  it('rejects garbage', () => {
    expect(parseRepoInput('')).toBeNull();
    expect(parseRepoInput('not a repo')).toBeNull();
    expect(parseRepoInput('https://gitlab.com/a/b')).toBeNull();
    expect(parseRepoInput('justoneword')).toBeNull();
  });
});
