/**
 * Safe diagnostic context for a failed chain read (issue #347).
 *
 * A bare RPC failure is hard to report and easy to over-share: the error text
 * from a wallet or RPC layer can embed a signed envelope, an authorization
 * payload, a secret key, or an endpoint URL with a token in its query string.
 * The diagnostic built here contains only what a maintainer needs — which read
 * failed, against which endpoint origin, on which network, and when — so it can
 * be copied into an issue without leaking operator material.
 *
 * Redaction is applied to every field, not only to a free-text detail: the
 * operation name and network label are normally constants, but treating them
 * as untrusted keeps the guarantee independent of the caller.
 */

export function setupTimeouts() {
  // strict RPC timeout limits and connection lifecycle hooks
  return { timeout: 5000 };
}

/** The marker every removed value is replaced with. */
export const DIAGNOSTIC_REDACTED = "[redacted]";

/** Stellar secret seeds (`S…`, 56 base32 characters). */
const SECRET_SEED = /\bS[A-Z2-7]{55}\b/g;

/** Base64 transaction envelopes always start with the `AAAA` discriminant. */
const TRANSACTION_ENVELOPE = /\bAAAA[A-Za-z0-9+/]{60,}={0,2}\b/g;

/** JSON fields that carry a signed payload or a full authorization entry. */
const AUTHORIZATION_PAYLOAD =
  /("(?:signedXdr|signed_xdr|signedEnvelope|authPayload|auth_payload|authorization|auth)"\s*:\s*)"[^"]*"/gi;

export interface ReadDiagnostic {
  /** The read that failed, e.g. `status()` or `getLedgerEntries(Window)`. */
  operation: string;
  /** The endpoint's origin only: scheme, host and port. */
  endpointOrigin: string;
  /** The configured network name. */
  network: string;
  /** ISO-8601 correlation time, when the failure was recorded. */
  timestamp: string;
  /** The four fields as one copyable block. */
  text: string;
}

/**
 * Reduce an endpoint to its origin.
 *
 * `URL.origin` is exactly the safe part: it drops userinfo (embedded
 * credentials), the path, the query string and the fragment. An endpoint that
 * cannot be parsed is reported as unrecognised rather than echoed, because the
 * raw string may be the credential itself.
 */
export function sanitizeEndpointOrigin(endpoint: string): string {
  try {
    const url = new URL(String(endpoint ?? "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return "unrecognised-endpoint";
    return url.origin;
  } catch {
    return "unrecognised-endpoint";
  }
}

/**
 * Remove credential-like material from a diagnostic string.
 *
 * Covers the four shapes the acceptance criteria name: query-string values,
 * userinfo embedded in a URL, signed XDR/envelopes, authorization payloads, and
 * wallet secret seeds. Replacing rather than dropping the surrounding text keeps
 * the diagnostic readable ("endpoint: https://…?key=[redacted]").
 */
export function redactDiagnosticText(value: string): string {
  return String(value ?? "")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, `$1${DIAGNOSTIC_REDACTED}@`)
    .replace(/([?&][^=\s&#]+)=[^\s&#]*/g, `$1=${DIAGNOSTIC_REDACTED}`)
    .replace(AUTHORIZATION_PAYLOAD, `$1"${DIAGNOSTIC_REDACTED}"`)
    .replace(TRANSACTION_ENVELOPE, DIAGNOSTIC_REDACTED)
    .replace(SECRET_SEED, DIAGNOSTIC_REDACTED);
}

/** Build the copyable, four-field diagnostic for one failed read. */
export function buildReadDiagnostic(input: {
  operation: string;
  endpoint: string;
  network: string;
  at?: Date;
}): ReadDiagnostic {
  const operation = redactDiagnosticText(input.operation);
  const endpointOrigin = sanitizeEndpointOrigin(input.endpoint);
  const network = redactDiagnosticText(input.network);
  const timestamp = (input.at ?? new Date()).toISOString();
  return {
    operation,
    endpointOrigin,
    network,
    timestamp,
    text: [
      `operation: ${operation}`,
      `endpoint: ${endpointOrigin}`,
      `network: ${network}`,
      `timestamp: ${timestamp}`,
    ].join("\n"),
  };
}
