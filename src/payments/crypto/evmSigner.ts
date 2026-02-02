import type { BytesLike, Signature } from 'ethers';

export interface EvmSigner {
  getAddress(): Promise<string>;
  signDigest(digest32: BytesLike): Promise<Signature>;
}

