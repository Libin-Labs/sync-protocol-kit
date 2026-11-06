# @lp-labs/sync-protocol-kit

Validate versioned synchronization envelopes and exchange acknowledgements, cursors, and
capability descriptions. This is a local data contract only: it does not provide transport,
storage, authentication, ordering, retry, conflict resolution, or delivery semantics.

## Install and quick start

```sh
npm install @lp-labs/sync-protocol-kit
```

```js
import { validateSyncEnvelope, negotiateCapabilities } from '@lp-labs/sync-protocol-kit';

const local = {
  versions: [1],
  features: ['batch', 'cursor-resume'],
  maxBatchSize: 100,
  acknowledgements: true,
  cursors: true,
};
const peerMessage = validateSyncEnvelope({
  protocol: 'lp-sync',
  version: 1,
  id: 'hello-1',
  kind: 'hello',
  payload: { capabilities: local },
});
console.log(peerMessage.kind, negotiateCapabilities(local, local));
```

## API and types

- `validateSyncEnvelope(value, limits?)` validates and detaches one `hello`, `changes`, `ack`, or
  `cursor` envelope.
- `parseSyncEnvelope(text, limits?)` parses bounded JSON text and validates it.
- `serializeSyncEnvelope(envelope, limits?)` validates before serializing.
- `negotiateCapabilities(local, remote)` selects a common advertised version, feature intersection,
  minimum batch size, and mutually supported acknowledgement/cursor flags.
- `SyncProtocolError` carries codes including `INVALID_ENVELOPE`, `INVALID_CAPABILITIES`,
  `INVALID_PAYLOAD`, `UNSUPPORTED_VERSION`, `NO_COMMON_VERSION`, and `LIMIT_EXCEEDED`.
- Types: `JsonValue`, `SyncCapabilities`, `SyncPayload`, `SyncPayloadByKind`, `SyncEnvelope`,
  `SyncLimits`, and `NegotiatedCapabilities`.

Envelope version 1 has a fixed protocol tag, bounded ID, kind, and kind-specific payload:
capabilities for `hello`, a cursor and JSON change list for `changes`, an accepted/rejected
message reference for `ack`, or a stream token (possibly null) for `cursor`. Rejected acknowledgments
may include a reason; accepted ones may not. Capability lists reject duplicates.
Advertised capability versions describe the peers' application-level sync contract; this kit itself
validates only the version-1 envelope wrapper and does not implement other envelope versions.

Default bounds are 1 MiB UTF-8 envelope text, JSON depth 32, 10,000 nodes, 100,000 characters per
string, 1,000 changes per batch, and 64 capability entries. Override per call with `SyncLimits`.
The conformance fixtures under `tests/fixtures` document accepted and rejected examples; they are
not an external standard or a claim of interoperability. No runtime or peer dependencies are used.
Validation and serialization are linear in the bounded envelope JSON size; capability negotiation
is linear in the peer capability list sizes.

## Module formats and customization

ESM, CommonJS, and TypeScript declarations are included. CommonJS:
`const { parseSyncEnvelope } = require('@lp-labs/sync-protocol-kit')`. Keep application message
schemas and transport policy outside this package, and version your payload contracts independently.
There are no runtime or peer dependencies; TypeScript and Prettier are development-only.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
