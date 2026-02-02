import { BytesLike, Signature, SigningKey, computeAddress, getBytes, hexlify } from 'ethers';
import type { EvmSigner } from './evmSigner.js';

export class PrivateKeyEvmSigner implements EvmSigner {
  private signingKey: SigningKey;
  private address: string;

  constructor(privateKey: string) {
    if (!privateKey || !privateKey.startsWith('0x') || privateKey.length < 66) {
      throw new Error('invalid_private_key');
    }
    this.signingKey = new SigningKey(privateKey);
    // SigningKey.publicKey is a 0x04... uncompressed secp256k1 key
    this.address = computeAddress(this.signingKey.publicKey);
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async signDigest(digest32: BytesLike): Promise<Signature> {
    const digest = getBytes(digest32);
    if (digest.length !== 32) throw new Error('digest_must_be_32_bytes');
    const sig = this.signingKey.sign(digest);
    return Signature.from({ r: sig.r, s: sig.s, yParity: sig.yParity });
  }
}

export function requireLocalPrivateKey() {
  const pk = process.env.LOCAL_EVM_PRIVATE_KEY;
  if (!pk) throw new Error('LOCAL_EVM_PRIVATE_KEY not configured');
  return pk;
}

