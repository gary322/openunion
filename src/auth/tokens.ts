import { createHash, createHmac } from 'crypto';

export const DEFAULT_PREFIX_LEN = 12;

export function tokenPrefix(token: string, prefixLen = DEFAULT_PREFIX_LEN) {
  return token.slice(0, prefixLen);
}

export function sha256Hex(input: string) {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(input: string, pepper: string) {
  return createHmac('sha256', pepper).update(input).digest('hex');
}

