import { describe, expect, it } from 'vitest';
import { getList, pushToList } from '../src/lib/storage';
import { decide } from '../src/lib/queue';
import type { Principal } from '../src/lib/rbac';

const ADMIN: Principal = {
  userId: 1,
  label: 'test admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};

describe('approval queue persistence', () => {
  it('writes decisions back to the list the queue reads', async () => {
    const id = `registration-${Date.now()}-${Math.random()}`;
    await pushToList('registrations', {
      id,
      appNo: `MMAKF-R-${id}`,
      name: 'Queue Test',
      status: 'Received',
      history: [],
    }, 50);

    await decide(ADMIN, {
      queue: 'registrations',
      recordId: id,
      toStatus: 'Under review',
    });

    const row = (await getList<any>('registrations', 500)).find((item) => item.id === id);
    expect(row?.status).toBe('Under review');
    expect(row?.history).toHaveLength(1);
  });
});
