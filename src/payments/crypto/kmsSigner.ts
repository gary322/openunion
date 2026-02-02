import { createPublicKey } from 'crypto';
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { BytesLike, Signature, computeAddress, getBytes, hexlify, recoverAddress, toBeHex } from 'ethers';
import type { EvmSigner } from './evmSigner.js';

// secp256k1 curve order
const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const SECP256K1_HALF_N = SECP256K1_N / 2n;

function derToRS(der: Uint8Array): { r: bigint; s: bigint } {
  const buf = Buffer.from(der);
  if (buf.length < 8 || buf[0] !== 0x30) throw new Error('kms_signature_bad_der');
  let offset = 2; // 0x30 len
  if (buf[1] & 0x80) {
    const n = buf[1] & 0x7f;
    offset = 2 + n;
  }
  if (buf[offset] !== 0x02) throw new Error('kms_signature_bad_der');
  const rLen = buf[offset + 1];
  const rBytes = buf.subarray(offset + 2, offset + 2 + rLen);
  offset = offset + 2 + rLen;
  if (buf[offset] !== 0x02) throw new Error('kms_signature_bad_der');
  const sLen = buf[offset + 1];
  const sBytes = buf.subarray(offset + 2, offset + 2 + sLen);

  const r = BigInt('0x' + rBytes.toString('hex'));
  const s = BigInt('0x' + sBytes.toString('hex'));
  return { r, s };
}

function to32BytesHex(v: bigint) {
  return toBeHex(v, 32);
}

export class KmsEvmSigner implements EvmSigner {
  private kms: KMSClient;
  private keyId: string;
  private cachedAddress?: string;

  constructor(input: { keyId: string; region?: string }) {
    this.keyId = input.keyId;
    this.kms = new KMSClient({ region: input.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1' });
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress;
    const res = await this.kms.send(new GetPublicKeyCommand({ KeyId: this.keyId }));
    if (!res.PublicKey) throw new Error('kms_public_key_missing');
    const spki = Buffer.from(res.PublicKey);
    const keyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const jwk = keyObj.export({ format: 'jwk' }) as any;
    if (!jwk?.x || !jwk?.y) throw new Error('kms_public_key_bad_jwk');
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);
    this.cachedAddress = computeAddress(hexlify(uncompressed));
    return this.cachedAddress;
  }

  async signDigest(digest32: BytesLike): Promise<Signature> {
    const digest = getBytes(digest32);
    if (digest.length !== 32) throw new Error('digest_must_be_32_bytes');

    const res = await this.kms.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: digest,
        MessageType: 'DIGEST',
        SigningAlgorithm: 'ECDSA_SHA_256',
      })
    );
    if (!res.Signature) throw new Error('kms_signature_missing');

    let { r, s } = derToRS(res.Signature);

    // Enforce low-s (EIP-2); if we flip s we must also flip yParity.
    const flipParity = s > SECP256K1_HALF_N;
    if (flipParity) s = SECP256K1_N - s;

    // Determine recovery param by trying both yParity values.
    const rHex = to32BytesHex(r);
    const sHex = to32BytesHex(s);
    const hashHex = hexlify(digest);
    const addr = await this.getAddress();

    for (const yParity of [0, 1] as const) {
      const yp = flipParity ? ((yParity ^ 1) as 0 | 1) : yParity;
      const sig = Signature.from({ r: rHex, s: sHex, yParity: yp });
      const rec = recoverAddress(hashHex, sig);
      if (rec.toLowerCase() === addr.toLowerCase()) return sig;
    }

    throw new Error('kms_signature_recovery_failed');
  }
}

