export type VerifierVerdict = 'pass' | 'fail' | 'inconclusive';

export interface VerifierGatewayResult {
  verdict: VerifierVerdict;
  reason: string;
  scorecard?: any;
  evidenceArtifacts?: any[];
  runMetadata?: any;
}

function requireGatewayUrl() {
  const url = process.env.VERIFIER_GATEWAY_URL;
  if (!url) throw new Error('VERIFIER_GATEWAY_URL not configured');
  return url;
}

export async function runVerifierGateway(input: {
  verificationId: string;
  submissionId: string;
  attemptNo: number;
  jobSpec: any;
  submission: any;
}): Promise<VerifierGatewayResult> {
  const url = requireGatewayUrl();

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.VERIFIER_GATEWAY_AUTH_HEADER ? { Authorization: process.env.VERIFIER_GATEWAY_AUTH_HEADER } : {}),
    },
    body: JSON.stringify(input),
  });

  if (!resp.ok) {
    throw new Error(`verifier_gateway_failed:${resp.status}`);
  }

  const body = (await resp.json()) as any;
  const verdict = body?.verdict as VerifierVerdict | undefined;
  const reason = body?.reason as string | undefined;
  const scorecard = body?.scorecard as any;

  if (!verdict || !['pass', 'fail', 'inconclusive'].includes(verdict)) {
    throw new Error('verifier_gateway_invalid_verdict');
  }
  if (!reason || typeof reason !== 'string') {
    throw new Error('verifier_gateway_invalid_reason');
  }
  if (
    !scorecard ||
    typeof scorecard !== 'object' ||
    !Number.isFinite(scorecard.R) ||
    !Number.isFinite(scorecard.E) ||
    !Number.isFinite(scorecard.A) ||
    !Number.isFinite(scorecard.N) ||
    !Number.isFinite(scorecard.T) ||
    !Number.isFinite(scorecard.qualityScore)
  ) {
    throw new Error('verifier_gateway_invalid_scorecard');
  }

  return {
    verdict,
    reason,
    scorecard,
    evidenceArtifacts: Array.isArray(body?.evidenceArtifacts) ? body.evidenceArtifacts : undefined,
    runMetadata: body?.runMetadata,
  };
}

