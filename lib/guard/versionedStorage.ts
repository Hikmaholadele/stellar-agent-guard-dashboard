/** Shared contracts for recoverable browser-persisted records. */

export type StorageErrorKind =
  "quota" | "permission" | "parse" | "unavailable" | "future-version" | "migration" | "unknown";

export type StorageOutcome<T> = { ok: true; value: T } | { ok: false; error: StorageErrorKind };

export interface BrowserStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface VersionedRecord<T> {
  schema: string;
  version: number;
  data: T;
}

export type VersionedRead<T> =
  | { ok: true; value: T; needsMigration: boolean }
  | { ok: false; error: StorageErrorKind; recoveryExport: string };

export function classifyStorageError(error: unknown): StorageErrorKind {
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return "quota";
    if (name === "SecurityError" || name === "NotAllowedError") return "permission";
  }
  return "unknown";
}

export function writeStoredValue(
  storage: BrowserStorageLike | null,
  key: string,
  value: string,
): StorageOutcome<void> {
  if (!storage) return { ok: false, error: "unavailable" };
  try {
    storage.setItem(key, value);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: classifyStorageError(error) };
  }
}

export function encodeVersionedRecord<T>(schema: string, version: number, data: T): string {
  return JSON.stringify({ schema, version, data } satisfies VersionedRecord<T>);
}

/** Decode a current envelope or deterministically migrate a legacy payload. */
export function decodeVersionedRecord<T>(options: {
  raw: string;
  schema: string;
  version: number;
  migrations: Readonly<Record<number, (value: unknown) => unknown>>;
  validate: (value: unknown) => value is T;
}): VersionedRead<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.raw) as unknown;
  } catch {
    return { ok: false, error: "parse", recoveryExport: options.raw };
  }

  let sourceVersion = 0;
  let value = parsed;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const envelope = parsed as Partial<VersionedRecord<unknown>>;
    if ("schema" in envelope || "version" in envelope || "data" in envelope) {
      if (
        envelope.schema !== options.schema ||
        !Number.isSafeInteger(envelope.version) ||
        typeof envelope.version !== "number" ||
        !("data" in envelope)
      ) {
        return { ok: false, error: "parse", recoveryExport: options.raw };
      }
      if (envelope.version > options.version) {
        return { ok: false, error: "future-version", recoveryExport: options.raw };
      }
      sourceVersion = envelope.version;
      value = envelope.data;
    }
  }

  const needsMigration = sourceVersion < options.version;
  while (sourceVersion < options.version) {
    const migrate = options.migrations[sourceVersion];
    if (!migrate) return { ok: false, error: "migration", recoveryExport: options.raw };
    try {
      value = migrate(value);
    } catch {
      return { ok: false, error: "migration", recoveryExport: options.raw };
    }
    sourceVersion += 1;
  }

  if (!options.validate(value)) {
    return { ok: false, error: "parse", recoveryExport: options.raw };
  }
  return { ok: true, value, needsMigration };
}

export function storageErrorMessage(error: StorageErrorKind): string {
  switch (error) {
    case "quota":
      return "Browser storage is full. Your changes remain active for this session.";
    case "permission":
      return "Browser storage access was denied. Your changes remain active for this session.";
    case "unavailable":
      return "Browser storage is unavailable. Your changes remain active for this session.";
    case "parse":
      return "A saved browser record could not be read and was left unchanged.";
    case "future-version":
      return "A saved browser record was written by a newer version and was left unchanged.";
    case "migration":
      return "A saved browser record could not be migrated and was left unchanged.";
    case "unknown":
      return "Browser storage rejected the change. Your changes remain active for this session.";
  }
}
