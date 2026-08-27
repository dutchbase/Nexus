export type ImageExistenceResult = { exists: boolean; digest?: string; checkedAt: string; authRequired: boolean };

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
    headers: { authorization: `Bearer ${anonymousToken}`, accept: "application/vnd.oci.image.manifest.v1+json" },
  });
  if (anonymousResponse.status === 200) {
    return { exists: true, digest: anonymousResponse.headers.get("docker-content-digest") ?? undefined, checkedAt, authRequired: false };
  }
  if (anonymousResponse.status === 404) return { exists: false, checkedAt, authRequired: false };
  if ((anonymousResponse.status === 401 || anonymousResponse.status === 403) && process.env.GHCR_READ_TOKEN) {
    const authedResponse = await fetch(manifestUrl, {
      headers: { authorization: `Bearer ${process.env.GHCR_READ_TOKEN}`, accept: "application/vnd.oci.image.manifest.v1+json" },
    });
    if (authedResponse.status === 200) return { exists: true, digest: authedResponse.headers.get("docker-content-digest") ?? undefined, checkedAt, authRequired: true };
    if (authedResponse.status === 404) return { exists: false, checkedAt, authRequired: true };
    throw new Error(`GHCR manifest check failed with status ${authedResponse.status}`);
  }
  throw new Error(`GHCR manifest check failed with status ${anonymousResponse.status}`);
}
