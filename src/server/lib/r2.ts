import { env } from "cloudflare:workers";

export async function getJsonFromR2(key: string): Promise<string> {
  const object = await env.R2.get(key);
  if (!object) {
    throw new Error("Audit payload not found");
  }

  return object.text();
}

/** An image decoded out of a data: URI, ready for R2. */
interface DecodedDataUri {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Decode a "data:image/jpeg;base64,..." URI. Returns null for anything that is
 * not base64 image data, so a malformed provider payload is skipped rather
 * than stored as a broken object.
 */
export function decodeImageDataUri(dataUri: string): DecodedDataUri | null {
  const comma = dataUri.indexOf(",");
  if (comma === -1) return null;
  const header = dataUri.slice(5, comma);
  if (!header.endsWith(";base64")) return null;
  const contentType = header.slice(0, -";base64".length);
  if (!contentType.startsWith("image/")) return null;
  try {
    const binary = atob(dataUri.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes, contentType };
  } catch {
    return null;
  }
}

/** Fetch a stored binary object (e.g. an audit screenshot). */
export async function getObjectFromR2(
  key: string,
): Promise<R2ObjectBody | null> {
  return env.R2.get(key);
}

export async function putBytesToR2(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<{ key: string; sizeBytes: number }> {
  await env.R2.put(key, body, {
    httpMetadata: {
      contentType,
      // Content-addressed by audit id: an audit's screenshots never change
      // once written, so viewers and the shared report can cache them hard.
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  return { key, sizeBytes: body.byteLength };
}

export async function putTextToR2(
  key: string,
  body: string,
): Promise<{ key: string; sizeBytes: number }> {
  await env.R2.put(key, body, {
    httpMetadata: {
      contentType: "application/json",
    },
  });

  return {
    key,
    sizeBytes: Buffer.byteLength(body),
  };
}
