// Envelope encryption, key wrapping, and AEAD helpers land here (T4 — crypto
// module). See docs/design/encryption.md and docs/security/threat-model.md §5/§7.
export { encryptField, decryptField, wipe } from "./aead";
export { serializeAad, type AadContext } from "./aad";
export { getDevUserDataKey } from "./dev-key-provider";
