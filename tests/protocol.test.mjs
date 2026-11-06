import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateSyncEnvelope,
  parseSyncEnvelope,
  serializeSyncEnvelope,
  negotiateCapabilities,
  SyncProtocolError,
} from '../dist/esm/index.js';

const fixture = (name) => JSON.parse(readFileSync(join('tests', 'fixtures', name), 'utf8'));

test('validates versioned conformance fixtures for all envelope kinds', () => {
  for (const name of ['hello.json', 'changes.json', 'ack.json', 'cursor.json']) {
    assert.equal(validateSyncEnvelope(fixture(name)).version, 1);
  }
  assert.equal(fixture('changes.json').payload.changes.length, 1);
});

test('rejects invalid conformance fixtures with specific error categories', () => {
  assert.throws(() => validateSyncEnvelope(fixture('invalid-version.json')), {
    code: 'UNSUPPORTED_VERSION',
  });
  assert.throws(() => validateSyncEnvelope(fixture('invalid-ack.json')), {
    code: 'INVALID_PAYLOAD',
  });
});

test('round-trips an envelope through the JSON helpers', () => {
  const parsed = parseSyncEnvelope(serializeSyncEnvelope(fixture('changes.json')));
  assert.deepEqual(parsed, fixture('changes.json'));
});

test('negotiates the highest shared supported version and common capabilities', () => {
  assert.deepEqual(
    negotiateCapabilities(
      {
        versions: [1, 2],
        features: ['batch', 'resume', 'local-only'],
        maxBatchSize: 64,
        acknowledgements: true,
        cursors: true,
      },
      {
        versions: [2, 1],
        features: ['batch', 'resume', 'remote-only'],
        maxBatchSize: 16,
        acknowledgements: false,
        cursors: true,
      },
    ),
    {
      version: 2,
      features: ['batch', 'resume'],
      maxBatchSize: 16,
      acknowledgements: false,
      cursors: true,
    },
  );
});

test('rejects peers with no common version', () => {
  assert.throws(
    () =>
      negotiateCapabilities(
        {
          versions: [1],
          features: [],
          maxBatchSize: 1,
          acknowledgements: false,
          cursors: false,
        },
        {
          versions: [2],
          features: [],
          maxBatchSize: 1,
          acknowledgements: false,
          cursors: false,
        },
      ),
    { code: 'NO_COMMON_VERSION' },
  );
});

test('rejects envelope identifiers, kinds, protocol tags, versions, and unknown fields', () => {
  const base = fixture('cursor.json');
  for (const patch of [
    { id: '' },
    { kind: 'delete' },
    { protocol: 'other' },
    { version: 0 },
    { unexpected: true },
  ]) {
    assert.throws(() => validateSyncEnvelope({ ...base, ...patch }));
  }
});

test('rejects malformed payload shapes and unknown fields for each kind', () => {
  const hello = fixture('hello.json');
  assert.throws(() =>
    validateSyncEnvelope({
      ...hello,
      payload: { ...hello.payload, unexpected: 1 },
    }),
  );
  const changes = fixture('changes.json');
  assert.throws(() =>
    validateSyncEnvelope({
      ...changes,
      payload: { ...changes.payload, extra: true },
    }),
  );
  const cursor = fixture('cursor.json');
  assert.throws(() =>
    validateSyncEnvelope({
      ...cursor,
      payload: { ...cursor.payload, extra: true },
    }),
  );
});

test('validates capability version and feature lists without coercion', () => {
  const base = fixture('hello.json');
  for (const capabilities of [
    {
      versions: [],
      features: [],
      maxBatchSize: 1,
      acknowledgements: true,
      cursors: true,
    },
    {
      versions: [0],
      features: [],
      maxBatchSize: 1,
      acknowledgements: true,
      cursors: true,
    },
    {
      versions: [1, 1],
      features: [],
      maxBatchSize: 1,
      acknowledgements: true,
      cursors: true,
    },
    {
      versions: [1],
      features: ['x', 'x'],
      maxBatchSize: 1,
      acknowledgements: true,
      cursors: true,
    },
    {
      versions: [1],
      features: [''],
      maxBatchSize: 1,
      acknowledgements: true,
      cursors: true,
    },
    {
      versions: [1],
      features: [],
      maxBatchSize: 1.5,
      acknowledgements: true,
      cursors: true,
    },
    {
      versions: [1],
      features: [],
      maxBatchSize: 1,
      acknowledgements: 1,
      cursors: true,
    },
  ]) {
    assert.throws(
      () =>
        validateSyncEnvelope({
          ...base,
          payload: { capabilities },
        }),
      SyncProtocolError,
    );
  }
});

test('rejects capability array getters, holes, and custom properties', () => {
  const base = fixture('hello.json');
  let calls = 0;
  const versions = Object.defineProperty([], '0', {
    enumerable: true,
    get() {
      calls += 1;
      return 1;
    },
  });
  versions.length = 1;
  assert.throws(() =>
    validateSyncEnvelope({
      ...base,
      payload: {
        capabilities: {
          ...base.payload.capabilities,
          versions,
        },
      },
    }),
  );
  assert.equal(calls, 0);
  const features = ['batch'];
  features.extra = true;
  assert.throws(() =>
    validateSyncEnvelope({
      ...base,
      payload: {
        capabilities: {
          ...base.payload.capabilities,
          features,
        },
      },
    }),
  );
});

test('validates acknowledgement and cursor semantic constraints', () => {
  const ack = fixture('ack.json');
  assert.throws(
    () =>
      validateSyncEnvelope({
        ...ack,
        payload: { messageId: 'm', accepted: true, reason: 'not accepted' },
      }),
    { code: 'INVALID_PAYLOAD' },
  );
  assert.throws(
    () =>
      validateSyncEnvelope({
        ...ack,
        payload: { messageId: 'm', accepted: false, reason: '' },
      }),
    { code: 'INVALID_PAYLOAD' },
  );
  const cursor = fixture('cursor.json');
  assert.throws(
    () =>
      validateSyncEnvelope({
        ...cursor,
        payload: { stream: '', token: null },
      }),
    { code: 'INVALID_PAYLOAD' },
  );
});

test('supports null change cursors and empty change batches', () => {
  const envelope = {
    protocol: 'lp-sync',
    version: 1,
    id: 'empty',
    kind: 'changes',
    payload: { cursor: null, changes: [] },
  };
  assert.deepEqual(validateSyncEnvelope(envelope).payload, {
    cursor: null,
    changes: [],
  });
});

test('enforces envelope bytes, nested payload depth, node and batch limits', () => {
  assert.throws(() => validateSyncEnvelope(fixture('changes.json'), { maxBytes: 16 }), {
    code: 'LIMIT_EXCEEDED',
  });
  assert.throws(
    () =>
      validateSyncEnvelope(
        {
          protocol: 'lp-sync',
          version: 1,
          id: 'deep',
          kind: 'changes',
          payload: { cursor: null, changes: [{ nested: { value: 1 } }] },
        },
        { maxDepth: 1 },
      ),
    { code: 'LIMIT_EXCEEDED' },
  );
  assert.throws(
    () =>
      validateSyncEnvelope(
        {
          protocol: 'lp-sync',
          version: 1,
          id: 'nodes',
          kind: 'changes',
          payload: { cursor: null, changes: [{ a: 1, b: 2 }] },
        },
        { maxNodes: 1 },
      ),
    { code: 'LIMIT_EXCEEDED' },
  );
  assert.throws(() => validateSyncEnvelope(fixture('changes.json'), { maxBatchSize: 0 }), {
    code: 'LIMIT_EXCEEDED',
  });
  assert.throws(
    () =>
      validateSyncEnvelope(
        {
          protocol: 'lp-sync',
          version: 1,
          id: 'many',
          kind: 'changes',
          payload: { cursor: null, changes: [1, 2] },
        },
        { maxBatchSize: 1 },
      ),
    { code: 'LIMIT_EXCEEDED' },
  );
});

test('rejects malformed JSON and byte oversized text before parsing', () => {
  assert.throws(() => parseSyncEnvelope('{'), { code: 'INVALID_ENVELOPE' });
  assert.throws(() => parseSyncEnvelope(' '.repeat(20), { maxBytes: 10 }), {
    code: 'LIMIT_EXCEEDED',
  });
  assert.throws(() => parseSyncEnvelope(3), SyncProtocolError);
});

test('rejects cycles, undefined, nonfinite values, accessors, and symbols in payloads', () => {
  const cycle = {};
  cycle.self = cycle;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get: () => 1,
  });
  for (const value of [cycle, undefined, NaN, Infinity, accessor, { [Symbol('x')]: 1 }]) {
    assert.throws(() =>
      validateSyncEnvelope({
        protocol: 'lp-sync',
        version: 1,
        id: 'bad',
        kind: 'changes',
        payload: { cursor: null, changes: [value] },
      }),
    );
  }
});

test('rejects class instances, sparse arrays, extra array properties, and unsafe numeric values', () => {
  class Custom {
    value = 1;
  }
  const sparse = [];
  sparse[1] = 'x';
  const extra = [1];
  extra.extra = true;
  for (const value of [new Custom(), sparse, extra, Infinity]) {
    assert.throws(() =>
      validateSyncEnvelope({
        protocol: 'lp-sync',
        version: 1,
        id: 'bad',
        kind: 'changes',
        payload: { cursor: null, changes: [value] },
      }),
    );
  }
});

test('CommonJS entry point exposes envelope parsing and negotiation', () => {
  const require = createRequire(import.meta.url);
  const commonjs = require('../dist/cjs/index.js');
  assert.equal(commonjs.parseSyncEnvelope(JSON.stringify(fixture('cursor.json'))).kind, 'cursor');
  assert.equal(typeof commonjs.negotiateCapabilities, 'function');
});
