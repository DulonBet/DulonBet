import { decryptWithdrawalCode, encryptWithdrawalCode } from "./withdrawal-code.ts";

const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const key = btoa(String.fromCharCode(...keyBytes));

Deno.test("encrypts and decrypts a withdrawal code", async () => {
  const code = "TEST-1XBET-CODE-123";
  const envelope = await encryptWithdrawalCode(code, key);
  if (envelope === code || envelope.includes(code)) throw new Error("Plaintext leaked into envelope");
  const decrypted = await decryptWithdrawalCode(envelope, key);
  if (decrypted !== code) throw new Error("Decrypted code does not match original");
});

Deno.test("uses a fresh IV for each encryption", async () => {
  const first = await encryptWithdrawalCode("same-code", key);
  const second = await encryptWithdrawalCode("same-code", key);
  if (first === second) throw new Error("Repeated encryption produced identical envelopes");
  if (first.split(":")[2] === second.split(":")[2]) throw new Error("IV was reused");
});

Deno.test("rejects a modified ciphertext", async () => {
  const envelope = await encryptWithdrawalCode("sensitive-code", key);
  const parts = envelope.split(":");
  const ciphertext = Uint8Array.from(atob(parts[3]), (char) => char.charCodeAt(0));
  ciphertext[0] ^= 1;
  parts[3] = btoa(String.fromCharCode(...ciphertext));
  let rejected = false;
  try { await decryptWithdrawalCode(parts.join(":"), key); } catch { rejected = true; }
  if (!rejected) throw new Error("Tampered ciphertext was accepted");
});

Deno.test("rejects a wrong key", async () => {
  const envelope = await encryptWithdrawalCode("sensitive-code", key);
  const wrongKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  let rejected = false;
  try { await decryptWithdrawalCode(envelope, wrongKey); } catch { rejected = true; }
  if (!rejected) throw new Error("Wrong key was accepted");
});

Deno.test("rejects plaintext legacy values", async () => {
  let rejected = false;
  try { await decryptWithdrawalCode("old-plaintext-code", key); } catch { rejected = true; }
  if (!rejected) throw new Error("Legacy plaintext was accepted");
});

Deno.test("rejects a key that is not 32 bytes", async () => {
  let rejected = false;
  try { await encryptWithdrawalCode("sensitive-code", btoa("short")); } catch { rejected = true; }
  if (!rejected) throw new Error("Invalid key length was accepted");
});
