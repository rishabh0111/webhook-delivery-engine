'use strict';

const crypto = require('crypto');

const SIGNATURE_PREFIX = 'sha256=';

const HEADER_ID = 'x-webhook-id';
const HEADER_TIMESTAMP = 'x-webhook-timestamp';
const HEADER_SIGNATURE = 'x-webhook-signature';

// Hex HMAC-SHA256 over `timestamp + "." + raw_body`. rawBody is the EXACT
// stored bytes (a Buffer) — never a re-serialization — so the signature is
// byte-stable across languages, whitespace, and key ordering.
function computeSignature(secret, timestamp, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
}

function signatureHeader(secret, timestamp, rawBody) {
  return SIGNATURE_PREFIX + computeSignature(secret, timestamp, rawBody);
}

// Identity + signing headers for one delivery. The signature is included only
// when the subscription has a secret (null secret = skip signing).
function buildSignatureHeaders({ webhookId, timestamp, secret, rawBody }) {
  const headers = {
    [HEADER_ID]: webhookId,
    [HEADER_TIMESTAMP]: timestamp,
  };
  if (secret) {
    headers[HEADER_SIGNATURE] = signatureHeader(secret, timestamp, rawBody);
  }
  return headers;
}

module.exports = {
  SIGNATURE_PREFIX,
  HEADER_ID,
  HEADER_TIMESTAMP,
  HEADER_SIGNATURE,
  computeSignature,
  signatureHeader,
  buildSignatureHeaders,
};