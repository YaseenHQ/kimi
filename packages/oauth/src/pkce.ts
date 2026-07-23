/**
 * PKCE (RFC 7636) utilities, shared by every browser / authorization-code OAuth
 * flow (Anthropic Claude Pro/Max, OpenAI Codex). Uses the Web Crypto API,
 * which Node 24 exposes globally alongside modern browsers, so this module is
 * environment-agnostic — no `node:crypto` import.
 */

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Generate a PKCE code verifier (43-128 chars, unreserved) and its S256
 * code_challenge. The verifier is a high-entropy random 32-byte value
 * base64url-encoded; the challenge is the base64url-encoded SHA-256 hash of
 * the verifier, per RFC 7636 §4.2.
 */
export async function generatePKCE(): Promise<{ readonly verifier: string; readonly challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);

  const data = new TextEncoder().encode(verifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));

  return { verifier, challenge };
}
