function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function importAesKey(encodedKey: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const rawKey = base64ToBytes(encodedKey);
  if (rawKey.length !== 32) {
    throw new Error("WITHDRAWAL_CODE_ENCRYPTION_KEY doit contenir 32 octets encodés en base64.");
  }
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, usage);
}

export async function encryptWithdrawalCode(code: string, encodedKey: string): Promise<string> {
  const key = await importAesKey(encodedKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(code),
  );
  return "enc:v1:" + bytesToBase64(iv) + ":" + bytesToBase64(new Uint8Array(ciphertext));
}

export async function decryptWithdrawalCode(envelope: string, encodedKey: string): Promise<string> {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new Error("Le code enregistré n'est pas chiffré au format attendu.");
  }
  const key = await importAesKey(encodedKey, ["decrypt"]);
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(parts[2]) },
    key,
    base64ToBytes(parts[3]),
  );
  return new TextDecoder().decode(clear);
}
