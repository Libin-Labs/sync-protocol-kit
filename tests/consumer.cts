import sync = require('@lp-labs/sync-protocol-kit');

const parsed = sync.parseSyncEnvelope(
  JSON.stringify({
    protocol: 'lp-sync',
    version: 1,
    id: 'cursor',
    kind: 'cursor',
    payload: { stream: 'items', token: null },
  }),
);
const kind: 'hello' | 'changes' | 'ack' | 'cursor' = parsed.kind;
console.log(kind);
