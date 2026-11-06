export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface SyncCapabilities {
  readonly versions: readonly number[];
  readonly features: readonly string[];
  readonly maxBatchSize: number;
  readonly acknowledgements: boolean;
  readonly cursors: boolean;
}

export interface SyncPayloadByKind {
  readonly hello: { readonly capabilities: SyncCapabilities };
  readonly changes: {
    readonly cursor: string | null;
    readonly changes: readonly JsonValue[];
  };
  readonly ack: {
    readonly messageId: string;
    readonly accepted: boolean;
    readonly cursor?: string;
    readonly reason?: string;
  };
  readonly cursor: { readonly stream: string; readonly token: string | null };
}

export type SyncPayload = SyncPayloadByKind[keyof SyncPayloadByKind];

export type SyncEnvelope<K extends keyof SyncPayloadByKind = keyof SyncPayloadByKind> =
  K extends keyof SyncPayloadByKind
    ? {
        readonly protocol: 'lp-sync';
        readonly version: 1;
        readonly id: string;
        readonly kind: K;
        readonly payload: SyncPayloadByKind[K];
      }
    : never;

export interface SyncLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxStringLength?: number;
  readonly maxBatchSize?: number;
  readonly maxCapabilities?: number;
}

export interface NegotiatedCapabilities {
  readonly version: number;
  readonly features: readonly string[];
  readonly maxBatchSize: number;
  readonly acknowledgements: boolean;
  readonly cursors: boolean;
}

export class SyncProtocolError extends Error {
  readonly code:
    | 'INVALID_ENVELOPE'
    | 'INVALID_CAPABILITIES'
    | 'INVALID_PAYLOAD'
    | 'UNSUPPORTED_VERSION'
    | 'NO_COMMON_VERSION'
    | 'LIMIT_EXCEEDED';

  constructor(code: SyncProtocolError['code'], message: string) {
    super(message);
    this.name = 'SyncProtocolError';
    this.code = code;
  }
}

const envelopeFields = new Set(['protocol', 'version', 'id', 'kind', 'payload']);
const defaults = {
  maxBytes: 1_048_576,
  maxDepth: 32,
  maxNodes: 10_000,
  maxStringLength: 100_000,
  maxBatchSize: 1_000,
  maxCapabilities: 64,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function limitsOf(input: SyncLimits = {}) {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    throw new SyncProtocolError('LIMIT_EXCEEDED', 'Sync limits must be a plain record.');
  }
  const allowed = new Set([
    'maxBytes',
    'maxDepth',
    'maxNodes',
    'maxStringLength',
    'maxBatchSize',
    'maxCapabilities',
  ]);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor =
      typeof key === 'string' ? Object.getOwnPropertyDescriptor(input, key) : undefined;
    if (
      !descriptor ||
      !allowed.has(key as string) ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new SyncProtocolError('LIMIT_EXCEEDED', 'Sync limits contain unknown fields.');
    }
  }
  const limits = {
    maxBytes: input.maxBytes ?? defaults.maxBytes,
    maxDepth: input.maxDepth ?? defaults.maxDepth,
    maxNodes: input.maxNodes ?? defaults.maxNodes,
    maxStringLength: input.maxStringLength ?? defaults.maxStringLength,
    maxBatchSize: input.maxBatchSize ?? defaults.maxBatchSize,
    maxCapabilities: input.maxCapabilities ?? defaults.maxCapabilities,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (name === 'maxDepth' ? 0 : 1)) {
      throw new SyncProtocolError('LIMIT_EXCEEDED', `${name} must be a valid safe integer.`);
    }
  }
  return limits;
}

function record(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value))
    throw new SyncProtocolError('INVALID_ENVELOPE', `${label} must be a plain record.`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor =
      typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (
      !descriptor ||
      !allowed.has(key as string) ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new SyncProtocolError('INVALID_ENVELOPE', `${label} has unknown or non-data fields.`);
    }
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new SyncProtocolError('INVALID_ENVELOPE', `${label} is missing required fields.`);
  }
}

function boundedText(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new SyncProtocolError('INVALID_PAYLOAD', `${label} must be a non-empty bounded string.`);
  }
}

function arrayValues(input: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(input) || input.length > maximum) {
    throw new SyncProtocolError('LIMIT_EXCEEDED', `${label} must be a bounded array.`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new SyncProtocolError('INVALID_PAYLOAD', `${label} must be a dense data array.`);
    }
    result.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(input)) {
    if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))) {
      throw new SyncProtocolError('INVALID_PAYLOAD', `${label} cannot have extra properties.`);
    }
  }
  return result;
}

function jsonCopy(
  input: unknown,
  limits: ReturnType<typeof limitsOf>,
  budget: { nodes: number; bytes: number } = { nodes: 0, bytes: 0 },
): JsonValue {
  const active = new Set<object>();
  const visit = (value: unknown, depth: number): JsonValue => {
    budget.nodes += 1;
    if (budget.nodes > limits.maxNodes || depth > limits.maxDepth) {
      throw new SyncProtocolError('LIMIT_EXCEEDED', 'Payload exceeds configured JSON capacity.');
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      budget.bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (budget.bytes > limits.maxBytes) {
        throw new SyncProtocolError('LIMIT_EXCEEDED', 'Payload exceeds byte capacity.');
      }
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > limits.maxStringLength) {
        throw new SyncProtocolError(
          'LIMIT_EXCEEDED',
          'Payload string exceeds configured capacity.',
        );
      }
      budget.bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (budget.bytes > limits.maxBytes) {
        throw new SyncProtocolError('LIMIT_EXCEEDED', 'Payload exceeds byte capacity.');
      }
      return value;
    }
    if (typeof value !== 'object' || active.has(value)) {
      throw new SyncProtocolError('INVALID_PAYLOAD', 'Payload must be finite JSON without cycles.');
    }
    active.add(value);
    if (Array.isArray(value)) {
      budget.bytes += 2;
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new SyncProtocolError(
            'INVALID_PAYLOAD',
            'Payload arrays must be dense data arrays.',
          );
        }
        if (index > 0) budget.bytes += 1;
        result.push(visit(descriptor.value, depth + 1));
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))) {
          throw new SyncProtocolError(
            'INVALID_PAYLOAD',
            'Payload arrays cannot have extra properties.',
          );
        }
      }
      active.delete(value);
      return result;
    }
    if (!isRecord(value)) {
      throw new SyncProtocolError('INVALID_PAYLOAD', 'Payload objects must be plain records.');
    }
    const result: Record<string, JsonValue> = {};
    budget.bytes += 2;
    let fieldIndex = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string')
        throw new SyncProtocolError('INVALID_PAYLOAD', 'Symbols are not JSON fields.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new SyncProtocolError('INVALID_PAYLOAD', 'Payload objects must contain data fields.');
      }
      if (fieldIndex > 0) budget.bytes += 1;
      budget.bytes += new TextEncoder().encode(JSON.stringify(key)).byteLength + 1;
      fieldIndex += 1;
      if (budget.bytes > limits.maxBytes) {
        throw new SyncProtocolError('LIMIT_EXCEEDED', 'Payload exceeds byte capacity.');
      }
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    active.delete(value);
    return result;
  };
  return visit(input, 0);
}

function validateCapabilities(
  input: unknown,
  limits: ReturnType<typeof limitsOf>,
): SyncCapabilities {
  record(
    input,
    new Set(['versions', 'features', 'maxBatchSize', 'acknowledgements', 'cursors']),
    ['versions', 'features', 'maxBatchSize', 'acknowledgements', 'cursors'],
    'Capabilities',
  );
  const capabilities = input;
  const versionsInput = arrayValues(capabilities.versions, 'versions', limits.maxCapabilities);
  const featuresInput = arrayValues(capabilities.features, 'features', limits.maxCapabilities);
  if (
    versionsInput.length === 0 ||
    !Number.isSafeInteger(capabilities.maxBatchSize) ||
    (capabilities.maxBatchSize as number) < 1 ||
    (capabilities.maxBatchSize as number) > limits.maxBatchSize ||
    typeof capabilities.acknowledgements !== 'boolean' ||
    typeof capabilities.cursors !== 'boolean'
  ) {
    throw new SyncProtocolError(
      'INVALID_CAPABILITIES',
      'Capability values are invalid or exceed limits.',
    );
  }
  const versions = versionsInput.map((version) => {
    if (!Number.isSafeInteger(version) || (version as number) < 1) {
      throw new SyncProtocolError(
        'INVALID_CAPABILITIES',
        'Supported versions must be positive integers.',
      );
    }
    return version as number;
  });
  const features = featuresInput.map((feature) => {
    boundedText(feature, 'feature', 128);
    return feature;
  });
  if (new Set(versions).size !== versions.length || new Set(features).size !== features.length) {
    throw new SyncProtocolError(
      'INVALID_CAPABILITIES',
      'Capability lists cannot contain duplicates.',
    );
  }
  return {
    versions,
    features,
    maxBatchSize: capabilities.maxBatchSize as number,
    acknowledgements: capabilities.acknowledgements,
    cursors: capabilities.cursors,
  };
}

function validatePayload(
  kind: unknown,
  input: unknown,
  limits: ReturnType<typeof limitsOf>,
): SyncPayload {
  if (!isRecord(input))
    throw new SyncProtocolError('INVALID_PAYLOAD', 'Envelope payload must be a plain record.');
  if (kind === 'hello') {
    record(input, new Set(['capabilities']), ['capabilities'], 'Hello payload');
    return { capabilities: validateCapabilities(input.capabilities, limits) };
  }
  if (kind === 'changes') {
    record(input, new Set(['cursor', 'changes']), ['cursor', 'changes'], 'Changes payload');
    if (input.cursor !== null) boundedText(input.cursor, 'cursor', limits.maxStringLength);
    const changes = arrayValues(input.changes, 'changes', limits.maxBatchSize);
    const budget = { nodes: 0, bytes: 2 + Math.max(0, changes.length - 1) };
    return {
      cursor: input.cursor as string | null,
      changes: changes.map((change) => jsonCopy(change, limits, budget)),
    };
  }
  if (kind === 'ack') {
    record(
      input,
      new Set(['messageId', 'accepted', 'cursor', 'reason']),
      ['messageId', 'accepted'],
      'Acknowledgement payload',
    );
    boundedText(input.messageId, 'messageId', limits.maxStringLength);
    if (typeof input.accepted !== 'boolean') {
      throw new SyncProtocolError('INVALID_PAYLOAD', 'accepted must be a boolean.');
    }
    if (input.cursor !== undefined) boundedText(input.cursor, 'cursor', limits.maxStringLength);
    if (input.reason !== undefined) boundedText(input.reason, 'reason', limits.maxStringLength);
    if (input.accepted && input.reason !== undefined) {
      throw new SyncProtocolError(
        'INVALID_PAYLOAD',
        'Accepted acknowledgements cannot include a rejection reason.',
      );
    }
    return {
      messageId: input.messageId,
      accepted: input.accepted,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }),
      ...(input.reason === undefined ? {} : { reason: input.reason as string }),
    };
  }
  if (kind === 'cursor') {
    record(input, new Set(['stream', 'token']), ['stream', 'token'], 'Cursor payload');
    boundedText(input.stream, 'stream', limits.maxStringLength);
    if (input.token !== null) boundedText(input.token, 'token', limits.maxStringLength);
    return { stream: input.stream, token: input.token as string | null };
  }
  throw new SyncProtocolError('INVALID_ENVELOPE', 'Envelope kind is not supported.');
}

export function validateSyncEnvelope(input: unknown, inputLimits: SyncLimits = {}): SyncEnvelope {
  const limits = limitsOf(inputLimits);
  record(input, envelopeFields, ['protocol', 'version', 'id', 'kind', 'payload'], 'Sync envelope');
  if (input.protocol !== 'lp-sync') {
    throw new SyncProtocolError('INVALID_ENVELOPE', 'Unsupported protocol identifier.');
  }
  if (input.version !== 1)
    throw new SyncProtocolError('UNSUPPORTED_VERSION', 'Envelope version is not supported.');
  boundedText(input.id, 'id', 256);
  if (!['hello', 'changes', 'ack', 'cursor'].includes(input.kind as string)) {
    throw new SyncProtocolError('INVALID_ENVELOPE', 'Envelope kind is not supported.');
  }
  const envelope = {
    protocol: 'lp-sync',
    version: 1,
    id: input.id,
    kind: input.kind as SyncEnvelope['kind'],
    payload: validatePayload(input.kind, input.payload, limits),
  } as SyncEnvelope;
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > limits.maxBytes) {
    throw new SyncProtocolError('LIMIT_EXCEEDED', 'Envelope exceeds configured byte capacity.');
  }
  return envelope;
}

export function parseSyncEnvelope(text: string, limits: SyncLimits = {}): SyncEnvelope {
  const safeLimits = limitsOf(limits);
  if (typeof text !== 'string')
    throw new SyncProtocolError('INVALID_ENVELOPE', 'Input must be JSON text.');
  if (
    text.length > safeLimits.maxBytes ||
    new TextEncoder().encode(text).byteLength > safeLimits.maxBytes
  ) {
    throw new SyncProtocolError('LIMIT_EXCEEDED', 'Envelope exceeds configured byte capacity.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SyncProtocolError('INVALID_ENVELOPE', 'Input is not valid JSON.');
  }
  return validateSyncEnvelope(parsed, limits);
}

export function serializeSyncEnvelope(envelope: SyncEnvelope, limits: SyncLimits = {}): string {
  return JSON.stringify(validateSyncEnvelope(envelope, limits));
}

export function negotiateCapabilities(
  local: SyncCapabilities,
  remote: SyncCapabilities,
): NegotiatedCapabilities {
  const limits = limitsOf();
  const safeLocal = validateCapabilities(local, limits);
  const safeRemote = validateCapabilities(remote, limits);
  const common = safeLocal.versions.filter((version) => safeRemote.versions.includes(version));
  if (common.length === 0) {
    throw new SyncProtocolError('NO_COMMON_VERSION', 'Peers have no shared protocol version.');
  }
  return {
    version: Math.max(...common),
    features: safeLocal.features.filter((feature) => safeRemote.features.includes(feature)).sort(),
    maxBatchSize: Math.min(safeLocal.maxBatchSize, safeRemote.maxBatchSize),
    acknowledgements: safeLocal.acknowledgements && safeRemote.acknowledgements,
    cursors: safeLocal.cursors && safeRemote.cursors,
  };
}
