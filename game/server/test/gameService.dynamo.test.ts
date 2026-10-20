// Re-runs the existing GameService suites (lobby / campaign / counting+coalition / hidden-info) with the repo swapped
// for DynamoRepo on top of FakeDdb. `./helpers` is mocked so that `new Ctx()` in those suites builds a DynamoRepo-backed
// context; the suites themselves are imported unchanged (they register their tests into this file).
import { vi } from 'vitest';

// The suites use a frozen FakeClock, so many records share one millisecond. MemoryRepo keeps insertion order for such
// ties; DynamoDB orders them by the id in the sort key (random in production, unlike a real ticking clock in practice).
// Make ids monotonic so the comparison is about repo behaviour rather than tie-breaks.
vi.mock('../src/core/util', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/util')>();
  let n = 0;
  return { ...orig, newId: (bytes = 5) => (++n).toString(16).padStart(bytes * 2, '0') };
});

vi.mock('./helpers', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./helpers')>();
  const { DynamoRepo } = await import('../src/aws/dynamoRepo');
  const { FakeDdb } = await import('./fakes/fakeDdb');
  const { GameService } = await import('../src/core/gameService');
  class DdbCtx extends orig.Ctx {
    ddb = new FakeDdb();
    constructor() {
      super();
      this.repo = new DynamoRepo(this.ddb as never, this.ddb.tableName) as never; // Ctx types repo as MemoryRepo
      this.notifier = new orig.FakeNotifier(this.repo);
      this.svc = new GameService({
        repo: this.repo as never, notifier: this.notifier, scheduler: this.scheduler, clock: this.clock, maps: this.maps, startDelayMs: 1000,
      });
    }
  }
  return { ...orig, Ctx: DdbCtx };
});

import './lobby.test';
import './campaign.test';
import './counting.test';
import './hidden.test';
