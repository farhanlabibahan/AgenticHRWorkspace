import { describe, expect, it } from 'vitest';
import { firstParams } from '@/lib/utils';

describe('firstParams', () => {
  it('keeps the first value of a repeated key, like URLSearchParams.get', async () => {
    const params = await firstParams(Promise.resolve({ q: ['alpha', 'beta'], stage: 's1', empty: undefined }));
    expect(params).toEqual({ q: 'alpha', stage: 's1', empty: undefined });
  });
});
