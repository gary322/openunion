import { describe, expect, it } from 'vitest';

describe('Verifier gateway descriptor adapters', () => {
  it('fails deterministically when required_artifacts are missing', async () => {
    const { buildVerifierGateway } = await import('../services/verifier-gateway/server.js');
    const gw = buildVerifierGateway();

    const resp = await gw.inject({
      method: 'POST',
      url: '/run',
      payload: {
        verificationId: 'ver_1',
        submissionId: 'sub_1',
        attemptNo: 1,
        jobSpec: {
          constraints: { allowedOrigins: [] },
          taskDescriptor: {
            schema_version: 'v1',
            type: 'clips',
            capability_tags: ['ffmpeg'],
            input_spec: {},
            output_spec: { required_artifacts: [{ kind: 'video', count: 1 }] },
          },
        },
        submission: {
          submissionId: 'sub_1',
          manifest: { result: { expected: 'clip mp4', observed: 'generated clip' }, reproSteps: ['run ffmpeg'] },
          artifactIndex: [{ kind: 'screenshot', label: 'proof', sha256: 'abcd1234', url: 'https://example.com/x.png' }],
        },
      },
    });

    expect(resp.statusCode).toBe(200);
    const body = resp.json() as any;
    expect(body.verdict).toBe('fail');
    expect(String(body.reason)).toContain('missing_required_artifacts');
    expect(String(body.reason)).toContain('video');
  });

  it('passes when required_artifacts are satisfied (no Playwright harness needed)', async () => {
    const { buildVerifierGateway } = await import('../services/verifier-gateway/server.js');
    const gw = buildVerifierGateway();

    const resp = await gw.inject({
      method: 'POST',
      url: '/run',
      payload: {
        verificationId: 'ver_2',
        submissionId: 'sub_2',
        attemptNo: 1,
        jobSpec: {
          constraints: { allowedOrigins: [] },
          taskDescriptor: {
            schema_version: 'v1',
            type: 'github_scan',
            capability_tags: ['http', 'llm_summarize'],
            input_spec: {},
            output_spec: { required_artifacts: [{ kind: 'log', label_prefix: 'report', count: 1 }] },
          },
        },
        submission: {
          submissionId: 'sub_2',
          manifest: { result: { expected: 'report', observed: 'report' }, reproSteps: ['fetch', 'summarize'] },
          artifactIndex: [{ kind: 'log', label: 'report_main', sha256: 'abcd1234', url: 'https://example.com/report.txt' }],
        },
      },
    });

    expect(resp.statusCode).toBe(200);
    const body = resp.json() as any;
    expect(body.verdict).toBe('pass');
  });
});

