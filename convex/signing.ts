const encoder = new TextEncoder();
const maxSkewSeconds = 300;

export async function signPayload(
  secret: string,
  timestamp: string,
  body: string,
) {
  const bytes = await hmac(secret, `${timestamp}.${body}`);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function verifyPayload(
  secret: string,
  timestamp: string | null,
  body: string,
  signature: string | null,
) {
  if (
    !timestamp ||
    !/^\d{10}$/.test(timestamp) ||
    !signature ||
    !/^[0-9a-f]{64}$/.test(signature)
  ) {
    return false;
  }
  if (
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > maxSkewSeconds
  )
    return false;
  const key = await importKey(secret);
  const bytes = Uint8Array.from(signature.match(/.{2}/g)!, (hex) =>
    Number.parseInt(hex, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    encoder.encode(`${timestamp}.${body}`),
  );
}

export async function userRef(secret: string, subject: string) {
  const bytes = await hmac(secret, `lendloop:user-ref:${subject}`);
  return Array.from(bytes.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function hmac(secret: string, text: string) {
  const key = await importKey(secret);
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(text)),
  );
}

function importKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
