/**
 * Secrets for shared audit reports.
 *
 * A share link is a random token in the URL plus, optionally, a password. The
 * token is the primary secret — long enough that guessing is not a threat —
 * and the password exists so a link that leaks (a forwarded email, a pasted
 * chat message) does not hand over the report with it.
 *
 * Nothing here needs configuration: the password is salted per audit and the
 * view-token key is derived from that stored hash, so changing or removing the
 * password invalidates every outstanding view token for free.
 */

/**
 * 160 bits of entropy, base32-ish over an unambiguous alphabet. Rendered in a
 * URL people copy by hand, so the alphabet drops the characters that get
 * misread (0/O, 1/l/I).
 */
const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const TOKEN_LENGTH = 32;

/** PBKDF2 rounds. Paid once per unlock, so the cost lands on an attacker. */
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

/** How long a view token stays valid after a successful unlock. */
const VIEW_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const encoder = new TextEncoder();

export function generateShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_LENGTH));
  let token = "";
  for (const byte of bytes) {
    token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
  }
  return token;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Annotated with the concrete ArrayBuffer parameter: WebCrypto's BufferSource
// excludes SharedArrayBuffer-backed views, which the bare Uint8Array type
// still allows.
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Length-independent comparison, so a mismatch leaks no position. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Stored form: `pbkdf2$<iterations>$<salt b64>$<hash b64>`. */
export async function hashSharePassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifySharePassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, iterationsRaw, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterationsRaw || !saltB64 || !hashB64) {
    return false;
  }
  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  try {
    const expected = fromBase64(hashB64);
    const actual = await pbkdf2(password, fromBase64(saltB64), iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Key for view tokens. Bound to both the share token and the password hash, so
 * revoking the link or changing its password retires every token already
 * handed out.
 */
async function viewTokenKey(
  shareToken: string,
  passwordHash: string,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`${shareToken}:${passwordHash}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * A short-lived proof that this viewer already entered the password. It rides
 * on requests the report makes for its own assets (screenshots), which cannot
 * carry the password themselves.
 */
export async function issueViewToken(
  shareToken: string,
  passwordHash: string,
  now = Date.now(),
): Promise<string> {
  const expiresAt = now + VIEW_TOKEN_TTL_MS;
  const key = await viewTokenKey(shareToken, passwordHash);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(String(expiresAt)),
  );
  return `${expiresAt}.${toBase64(new Uint8Array(signature))}`;
}

export async function verifyViewToken(
  viewToken: string,
  shareToken: string,
  passwordHash: string,
  now = Date.now(),
): Promise<boolean> {
  const separator = viewToken.indexOf(".");
  if (separator === -1) return false;
  const expiresAtRaw = viewToken.slice(0, separator);
  const expiresAt = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  try {
    const key = await viewTokenKey(shareToken, passwordHash);
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(expiresAtRaw)),
    );
    return timingSafeEqual(
      fromBase64(viewToken.slice(separator + 1)),
      expected,
    );
  } catch {
    return false;
  }
}
