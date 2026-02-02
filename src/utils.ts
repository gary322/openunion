import { createHash } from 'crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function nowMs() {
  return Date.now();
}

export function isLeaseExpired(leaseExpiresAt?: number) {
  return leaseExpiresAt !== undefined && leaseExpiresAt < Date.now();
}
