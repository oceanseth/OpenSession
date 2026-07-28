import { describe, expect, it } from 'vitest';
import { normalizeXHandle } from './identity';

describe('normalizeXHandle', () => {
  it('accepts bare handles and strips @', () => {
    expect(normalizeXHandle('oceanseth')).toBe('oceanseth');
    expect(normalizeXHandle('@oceanseth')).toBe('oceanseth');
    expect(normalizeXHandle('  @Under_score9  ')).toBe('Under_score9');
  });

  it('rejects invalid handles', () => {
    expect(normalizeXHandle('')).toBeNull();
    expect(normalizeXHandle('@')).toBeNull();
    expect(normalizeXHandle('has space')).toBeNull();
    expect(normalizeXHandle('way_too_long_for_x_16')).toBeNull();
    expect(normalizeXHandle('bad-dash')).toBeNull();
    expect(normalizeXHandle('https://x.com/user')).toBeNull();
  });
});
