import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { dirname } from "node:path";
import { MAX_MANIFEST_BYTES, type UpdateSourceConfig } from "../../shared/contracts/update";
import { UpdateError } from "./errors";
import { decodeSignedManifest, resolveSecureUrl, type AuthenticatedManifest } from "./manifest";
import { MAX_PACKAGE_BYTES } from "./trust";

/**
 * The only network code in the update flow.
 *
 * HTTPS only, the configured host only, bounded bytes, bounded redirects, and
 * no proxy environment trust beyond Node's own TLS validation. A redirect to a
 * different host is a refusal, not a hop the caller can audit later.
 */

export const MAX_REDIRECTS = 2;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchedBytes {
  bytes: Buffer;
  url: string;
  redirects: string[];
}

function request(
  url: string,
  timeoutMs: number,
): Promise<{
  status: number;
  location: string | null;
  chunks: Buffer[];
  length: number;
  contentType: string | null;
}> {
  return new Promise((resolve, reject) => {
    const request_ = httpsGet(url, { timeout: timeoutMs, rejectUnauthorized: true }, (response) => {
      const status = response.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_MANIFEST_BYTES) {
          response.destroy();
          reject(
            new UpdateError("manifest_too_large", "the update manifest exceeds its size cap", {
              limit: MAX_MANIFEST_BYTES,
            }),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          status,
          location:
            typeof response.headers.location === "string" ? response.headers.location : null,
          chunks,
          length,
          contentType:
            typeof response.headers["content-type"] === "string"
              ? response.headers["content-type"]
              : null,
        });
      });
      response.on("error", reject);
    });
    request_.on("timeout", () => {
      request_.destroy(
        new UpdateError("manifest_malformed", "the update source did not answer in time"),
      );
    });
    request_.on("error", reject);
  });
}

/** Fetch a bounded document over HTTPS, following same-host HTTPS redirects. */
export async function fetchDocument(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FetchedBytes> {
  let current = url;
  const redirects: string[] = [];
  const origin = new URL(url);
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    const response = await request(current, timeoutMs);
    if (response.status >= 300 && response.status < 400) {
      if (response.location === null) {
        throw new UpdateError(
          "manifest_malformed",
          "the update source redirected without a location",
        );
      }
      const next = new URL(response.location, current);
      if (next.protocol !== "https:") {
        throw new UpdateError("insecure_source", "an update redirect left HTTPS");
      }
      if (next.host !== origin.host) {
        throw new UpdateError(
          "source_host_mismatch",
          "an update redirect left the configured host",
          { expected: origin.host, actual: next.host },
        );
      }
      redirects.push(next.toString());
      current = next.toString();
      continue;
    }
    if (response.status !== 200) {
      throw new UpdateError("manifest_malformed", `the update source answered ${response.status}`, {
        url: current,
      });
    }
    return { bytes: Buffer.concat(response.chunks), url: current, redirects };
  }
  throw new UpdateError("manifest_malformed", "the update source redirected too many times", {
    redirects,
  });
}

export function manifestUrl(source: UpdateSourceConfig): string {
  if (source.baseUrl === null || source.manifestPath === null) {
    throw new UpdateError("source_unconfigured", "no distribution source is configured");
  }
  return resolveSecureUrl(source.baseUrl, source.manifestPath);
}

/** Fetch and authenticate the manifest. A signature failure is a refusal. */
export async function fetchAuthenticatedManifest(
  source: UpdateSourceConfig,
  fetcher: (url: string) => Promise<FetchedBytes> = fetchDocument,
): Promise<AuthenticatedManifest> {
  if (source.mode !== "configured" || source.manifestKey === null) {
    throw new UpdateError(
      "source_unconfigured",
      "no authenticated distribution source is configured",
    );
  }
  const url = manifestUrl(source);
  const fetched = await fetcher(url);
  return decodeSignedManifest(fetched.bytes, source.manifestKey);
}

/**
 * Download a package to a private directory, hashing while it writes. The
 * partial file is removed on any failure and only a verified file is renamed
 * into place, so a handoff can never see a truncated download.
 */
export async function downloadPackage(options: {
  url: string;
  destination: string;
  expectedSha256: string;
  expectedSize: number;
  timeoutMs?: number;
}): Promise<{ path: string; sha256: string; sizeBytes: number }> {
  const { destination } = options;
  if (options.expectedSize > MAX_PACKAGE_BYTES) {
    throw new UpdateError("package_too_large", "the package exceeds the download size cap", {
      sizeBytes: options.expectedSize,
      limit: MAX_PACKAGE_BYTES,
    });
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const partial = `${destination}.partial`;
  rmSync(partial, { force: true });

  const timeoutMs = options.timeoutMs ?? 120_000;
  const hash = createHash("sha256");
  let received = 0;

  await new Promise<void>((resolve, reject) => {
    const request_ = httpsGet(
      options.url,
      { timeout: timeoutMs, rejectUnauthorized: true },
      (response) => {
        if ((response.statusCode ?? 0) !== 200) {
          response.destroy();
          reject(
            new UpdateError(
              "manifest_malformed",
              `the package host answered ${response.statusCode}`,
              {
                url: options.url,
              },
            ),
          );
          return;
        }
        const output = createWriteStream(partial, { mode: 0o600 });
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > Math.max(options.expectedSize, 1) + 1024 * 1024) {
            response.destroy();
            output.destroy();
            reject(new UpdateError("size_mismatch", "the download exceeded its declared size"));
            return;
          }
          hash.update(chunk);
          output.write(chunk);
        });
        response.on("end", () => output.end(resolve));
        response.on("error", reject);
        output.on("error", reject);
      },
    );
    request_.on("timeout", () =>
      request_.destroy(new UpdateError("manifest_malformed", "the package download timed out")),
    );
    request_.on("error", reject);
  }).catch((error) => {
    rmSync(partial, { force: true });
    throw error;
  });

  const sha256 = hash.digest("hex");
  const sizeBytes = statSync(partial).size;
  if (sizeBytes !== options.expectedSize) {
    rmSync(partial, { force: true });
    throw new UpdateError(
      "size_mismatch",
      `the downloaded package is ${sizeBytes} bytes; ${options.expectedSize} were declared`,
    );
  }
  if (sha256 !== options.expectedSha256) {
    rmSync(partial, { force: true });
    throw new UpdateError(
      "digest_mismatch",
      "the downloaded package bytes do not match the authenticated manifest digest",
    );
  }
  renameSync(partial, destination);
  return { path: destination, sha256, sizeBytes };
}
