import {
  validateSyncEnvelope,
  negotiateCapabilities,
  type SyncCapabilities,
} from '@lp-labs/sync-protocol-kit';

const local: SyncCapabilities = {
  versions: [1],
  features: ['batch'],
  maxBatchSize: 10,
  acknowledgements: true,
  cursors: true,
};
const envelope = validateSyncEnvelope({
  protocol: 'lp-sync',
  version: 1,
  id: 'hello',
  kind: 'hello',
  payload: { capabilities: local },
});
if (envelope.kind === 'hello') {
  const negotiated = negotiateCapabilities(envelope.payload.capabilities, local);
  console.log(negotiated.version);
}
