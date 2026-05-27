import crypto from 'crypto';


//signs the webhook delivery using hmac-sha256 over {timestamp}.{body}
//timestamp i use because it addes more security to the signature, it makes it harder for attackers to replay old requests, as they would need to know the exact timestamp and body to generate a valid signature. It also allows the receiver to verify that the request is recent and not a replay of an old request.
//this is what github does also in the webhooks.

export function sign(secret: string, timestamp: number, body: string): string {
  const payload = `${timestamp}.${body}`;
  const hex = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${hex}`;

}


//verfication is done using timingSafeEqual to prevent against timing attacks, which can be used to guess the signature by measuring the time it takes for the server to respond. By using a constant-time comparison, we can ensure that the verification process takes the same amount of time regardless of whether the signature is correct or not, making it more secure against such attacks.


export function verify(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
): boolean {
  const expected = sign(secret, timestamp, body);
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
