export type ImageExistenceResult = { exists: boolean; digest?: string; checkedAt: string; authRequired: boolean; error?: string };

// GHCR won't serve an OCI image manifest under the OCI-only Accept header for
// images built as multi-arch manifest INDEXES (the common docker-buildx
// case) — list every media type GHCR might return the tag as.
const manifestAcceptHeader = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

async function ghcrToken(repository: string, bearerOverride?: string): Promise<string> {
  if (bearerOverride) return bearerOverride;
  const response = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${encodeURIComponent(repository)}:pull`);
  const body = await response.json() as { token: string };
  return body.token;
}

// checkImageExists only supports the ghcr.io registry — other registry
// values pass Task 7's config shape validation as free text, but this
// function will throw if asked to check anything other than ghcr.io. Wider
// registry support is out of scope for v1.
export async function checkImageExists(registry: string, repository: string, tag: string): Promise<ImageExistenceResult> {
  if (registry !== "ghcr.io") throw new Error(`checkImageExists only supports the ghcr.io registry (got "${registry}")`);
  const checkedAt = new Date().toISOString();
  const anonymousToken = await ghcrToken(repository);
  const manifestUrl = `https://ghcr.io/v2/${repository}/manifests/${encodeURIComponent(tag)}`;
  const anonymousResponse = await fetch(manifestUrl, {
    headers: { authorization: `Bearer ${anonymousToken}`, accept: manifestAcceptHeader },
  });
  if (anonymousResponse.status === 200) {
    return { exists: true, digest: anonymousResponse.headers.get("docker-content-digest") ?? undefined, checkedAt, authRequired: false };
  }
  if (anonymousResponse.status === 404) return { exists: false, checkedAt, authRequired: false };
  // Rate-limiting and server errors are transient registry trouble, not proof
  // the image is missing — don't let them take down the whole deployment-status
  // sync job; report "couldn't determine, not blocking" instead.
  if (anonymousResponse.status === 429 || anonymousResponse.status >= 500) {
    return { exists: false, checkedAt, authRequired: false, error: "transient" };
  }
  if ((anonymousResponse.status === 401 || anonymousResponse.status === 403) && process.env.GHCR_READ_TOKEN) {
    const authedResponse = await fetch(manifestUrl, {
      headers: { authorization: `Bearer ${process.env.GHCR_READ_TOKEN}`, accept: manifestAcceptHeader },
    });
    if (authedResponse.status === 200) return { exists: true, digest: authedResponse.headers.get("docker-content-digest") ?? undefined, checkedAt, authRequired: true };
    if (authedResponse.status === 404) return { exists: false, checkedAt, authRequired: true };
    if (authedResponse.status === 429 || authedResponse.status >= 500) {
      return { exists: false, checkedAt, authRequired: true, error: "transient" };
    }
    throw new Error(`GHCR manifest check failed with status ${authedResponse.status}`);
  }
  throw new Error(`GHCR manifest check failed with status ${anonymousResponse.status}`);
}
