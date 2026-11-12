import { createHash, createPublicKey, sign, verify } from "node:crypto";
import {
  MAX_MANIFEST_BYTES,
  SignedManifestEnvelopeSchema,
  UpdateManifestSchema,
  type SignedManifestEnvelope,
  type UpdateManifest,
} from "../../shared/contracts/update";
import { UpdateError } from "./errors";

/**
 * Manifest authentication.
 *
 * A digest from an unauthenticated manifest proves nothing: an attacker who can
 * change the manifest can change the digest with it. The manifest is therefore
 * carried as an Ed25519-signed envelope over the exact JSON bytes, and the
 * public key is part of the configured source. TLS protects the transport; the
 * signature protects the document. The package signature protects the bytes.
 */

export interface AuthenticatedManifest {
  manifest: UpdateManifest;
  /** SHA-256 of the configured public key's DER encoding, hex. */
  keyFingerprint: string;
  /** SHA-256 of the exact manifest bytes the signature covered. */
  manifestDigest: string;
}

export function keyFingerprint(publicKeyBase64: string): string {
  const der = decodeBase64(publicKeyBase64, "manifest key");
  try {
    createPublicKey({ key: der, format: "der", type: "spki" });
  } catch (error) {
    throw new UpdateError(
      "manifest_key_mismatch",
      "the configured manifest key is not a valid Ed25519 public key",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return createHash("sha256").update(der).digest("hex");
}

function decodeBase64(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) {
    throw new UpdateError("manifest_malformed", `${label} is not base64`);
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0) {
    throw new UpdateError("manifest_malformed", `${label} decoded to nothing`);
  }
  return buffer;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new UpdateError("manifest_malformed", `${label} is not JSON`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Verify the envelope signature and return the manifest. A failure is a
 * refusal with a code, never a warning followed by a proceed.
 */
export function decodeSignedManifest(
  bytes: Buffer,
  publicKeyBase64: string,
): AuthenticatedManifest {
  if (bytes.length === 0) {
    throw new UpdateError("manifest_malformed", "the update manifest is empty");
  }
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new UpdateError("manifest_too_large", "the update manifest exceeds its size cap", {
      bytes: bytes.length,
      limit: MAX_MANIFEST_BYTES,
    });
  }
  const parsed = SignedManifestEnvelopeSchema.safeParse(parseJson(bytes, "update manifest"));
  if (!parsed.success) {
    throw new UpdateError("manifest_malformed", "the update manifest is not a signed envelope", {
      issues: parsed.error.issues.map((issue) => issue.message).slice(0, 5),
    });
  }
  const envelope: SignedManifestEnvelope = parsed.data;
  const payload = decodeBase64(envelope.payload, "manifest payload");
  if (payload.length > MAX_MANIFEST_BYTES) {
    throw new UpdateError(
      "manifest_too_large",
      "the signed manifest payload exceeds its size cap",
      {
        bytes: payload.length,
        limit: MAX_MANIFEST_BYTES,
      },
    );
  }
  const signature = decodeBase64(envelope.signature, "manifest signature");

  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey({
      key: decodeBase64(publicKeyBase64, "manifest key"),
      format: "der",
      type: "spki",
    });
  } catch (error) {
    throw new UpdateError(
      "manifest_key_mismatch",
      "the configured manifest key is not a valid Ed25519 public key",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  let authentic = false;
  try {
    authentic = verify(null, payload, key, signature);
  } catch (error) {
    throw new UpdateError(
      "manifest_signature_invalid",
      "the manifest signature could not be checked",
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (!authentic) {
    throw new UpdateError(
      "manifest_signature_invalid",
      "the manifest signature does not match its bytes and the configured key",
    );
  }

  const manifest = UpdateManifestSchema.safeParse(parseJson(payload, "signed manifest payload"));
  if (!manifest.success) {
    throw new UpdateError("manifest_malformed", "the signed manifest does not match the schema", {
      issues: manifest.error.issues.map((issue) => issue.message).slice(0, 5),
    });
  }
  return {
    manifest: manifest.data,
    keyFingerprint: keyFingerprint(publicKeyBase64),
    manifestDigest: createHash("sha256").update(payload).digest("hex"),
  };
}

/**
 * Build the signed envelope around known-good bytes. This is the release
 * tooling's half of the format: the product only ever verifies. The key is
 * supplied by the release tooling and is never stored in the product.
 */
export function encodeSignedManifest(manifest: UpdateManifest, privateKeyPem: string): Buffer {
  const payload = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const signature = sign(null, payload, privateKeyPem);
  const envelope: SignedManifestEnvelope = {
    schemaVersion: 1,
    algorithm: "ed25519",
    payload: payload.toString("base64"),
    signature: signature.toString("base64"),
  };
  return Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

/**
 * Resolve a reference against the configured origin. Only HTTPS on the
 * configured host is allowed, and no reference may escape its origin.
 */
export function resolveSecureUrl(baseUrl: string, reference: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new UpdateError("insecure_source", "the configured source is not a valid URL");
  }
  if (base.protocol !== "https:") {
    throw new UpdateError("insecure_source", "update sources must use HTTPS");
  }
  if (reference.split("/").includes("..")) {
    throw new UpdateError("insecure_source", "a package reference may not traverse upward", {
      reference,
    });
  }
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  let resolved: URL;
  try {
    resolved = new URL(reference, `${base.origin}${basePath}`);
  } catch {
    throw new UpdateError("manifest_malformed", "the manifest names an invalid package URL", {
      reference,
    });
  }
  if (resolved.protocol !== "https:") {
    throw new UpdateError("insecure_source", "the resolved package URL is not HTTPS", {
      url: resolved.toString(),
    });
  }
  if (resolved.host !== base.host) {
    throw new UpdateError(
      "source_host_mismatch",
      "the package URL is on a different host than the configured source",
      { expected: base.host, actual: resolved.host },
    );
  }
  if (resolved.username || resolved.password) {
    throw new UpdateError("insecure_source", "a package URL may not carry credentials");
  }
  // A reference may not escape the configured base path. URL normalization
  // collapses `..` before this check, so the path prefix is the real bound.
  if (basePath !== "/" && !resolved.pathname.startsWith(basePath)) {
    throw new UpdateError(
      "insecure_source",
      "the package URL is outside the configured base path",
      { base_path: basePath, resolved_path: resolved.pathname },
    );
  }
  return resolved.toString();
}

/** The host a configured source names, for display and a same-host check. */
export function sourceHost(baseUrl: string | null): string | null {
  if (baseUrl === null) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}
