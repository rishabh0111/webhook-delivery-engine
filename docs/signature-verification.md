# Verifying webhook signatures

Every delivery this engine sends carries identity headers, and — when the
subscription was created with a secret — an HMAC signature so you can verify the
request is authentic and hasn't been tampered with or replayed.

## Headers on each delivery

| Header                 | Meaning                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `X-Webhook-Id`         | Stable id for this event. Identical across retries/replays — dedup on it. |
| `X-Webhook-Timestamp`  | Unix time (seconds) when the attempt was signed. Part of the signature. |
| `X-Webhook-Signature`  | `sha256=<hex>` HMAC. **Only present when the subscription has a secret.** |

A subscription created with no secret receives **no** `X-Webhook-Signature`
header — those deliveries cannot be verified by design.

## The signature

```
signature = HMAC_SHA256(secret, timestamp + "." + raw_body)
```

- `secret` — the value returned once when the subscription was created.
- `timestamp` — the exact string from the `X-Webhook-Timestamp` header.
- `raw_body` — the **raw bytes of the request body, exactly as received**. Do not
  re-serialize, pretty-print, or re-order JSON keys before verifying; sign/verify
  the bytes off the wire.

The header value is the hex digest prefixed with `sha256=`.

## Recipe

1. Read `X-Webhook-Timestamp` (call it `t`) and `X-Webhook-Signature`.
2. (Recommended) Reject if `t` is too far from your current clock (e.g. > 5
   minutes) to bound replay attacks.
3. Build the signed payload by concatenating the **bytes** of `t + "."` with the
   **raw body bytes**.
4. Compute `HMAC-SHA256(secret, signedPayload)` and hex-encode it.
5. Compare `"sha256=" + yourHex` to the received header using a **constant-time**
   comparison.

### Node.js

```js
const crypto = require('crypto');

// rawBody MUST be the raw bytes/Buffer of the request body, not a parsed object.
function verify(secret, headers, rawBody) {
  const timestamp = headers['x-webhook-timestamp'];
  const received = headers['x-webhook-signature'];
  if (!timestamp || !received) return false;

  // Optional replay-window check (5 minutes).
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > 300) return false;

  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');

  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

> In Express, capture the raw bytes with `express.raw({ type: '*/*' })` (or a
> `verify` callback) — `express.json()` discards them, which would break
> verification.

### Python

```python
import hashlib, hmac, time

def verify(secret: str, headers: dict, raw_body: bytes) -> bool:
    timestamp = headers.get("x-webhook-timestamp")
    received = headers.get("x-webhook-signature")
    if not timestamp or not received:
        return False
    if abs(time.time() - int(timestamp)) > 300:
        return False
    signed = f"{timestamp}.".encode() + raw_body
    expected = "sha256=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(received, expected)
```
