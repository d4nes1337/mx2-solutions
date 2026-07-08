// Credential encryption now lives in @mx2/core so the worker (auto-execution) can
// decrypt L2 creds too, without importing across the apps/* boundary. Re-exported
// here to preserve existing import sites within the API.
export { encryptCredentials, decryptCredentials, fingerprintSecret, CryptoError } from "@mx2/core";
