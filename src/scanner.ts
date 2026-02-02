export interface ScanResult {
  ok: boolean;
  reason?: string;
}

function startsWith(buf: Buffer, prefix: number[]) {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix[i]) return false;
  return true;
}

function hasNullByte(buf: Buffer) {
  return buf.includes(0);
}

function looksLikeUtf8Text(buf: Buffer) {
  // Quick heuristic: no NUL bytes and decode/encode roundtrip doesn't explode.
  if (hasNullByte(buf)) return false;
  try {
    const s = buf.toString('utf8');
    // If it contains many replacement chars, it's probably not utf8 text.
    const replacements = (s.match(/\uFFFD/g) ?? []).length;
    return replacements / Math.max(1, s.length) < 0.01;
  } catch {
    return false;
  }
}

// Lightweight content scan (format sniffing + basic hygiene).
// For production malware scanning, prefer SCANNER_ENGINE=clamd with a clamd sidecar.
async function scanWithClamav(input: { bytes: Buffer }): Promise<ScanResult> {
  const { mkdtemp, rm, writeFile } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { spawn } = await import('child_process');

  const dir = await mkdtemp(join(tmpdir(), 'proofwork-scan-'));
  const file = join(dir, 'upload.bin');
  await writeFile(file, input.bytes);

  const res: ScanResult = await new Promise((resolve) => {
    const p = spawn('clamscan', ['--no-summary', '--stdout', '--infected', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => {
      // clamscan exit codes: 0=clean, 1=infected, 2=error
      if (code === 0) return resolve({ ok: true });
      if (code === 1) return resolve({ ok: false, reason: 'clamav_infected' });
      return resolve({ ok: false, reason: `clamav_error:${(err || out).slice(0, 200)}` });
    });
    p.on('error', (e) => resolve({ ok: false, reason: `clamav_spawn_error:${String((e as any)?.message ?? e)}` }));
  });

  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  return res;
}

export async function scanBytes(input: { bytes: Buffer; contentType?: string; filename?: string }): Promise<ScanResult> {
  const engine = String(process.env.SCANNER_ENGINE ?? '').toLowerCase().trim();
  const bytes = input.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) return { ok: false, reason: 'empty_file' };

  const ct = (input.contentType ?? '').toLowerCase().trim();

  let basic: ScanResult = { ok: true };

  if (ct === 'image/png') {
    const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    basic = startsWith(bytes, pngSig) ? { ok: true } : { ok: false, reason: 'content_type_mismatch_png' };
  }

  else if (ct === 'image/jpeg') {
    basic = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 ? { ok: true } : { ok: false, reason: 'content_type_mismatch_jpeg' };
  }

  else if (ct === 'application/pdf') {
    basic = startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) ? { ok: true } : { ok: false, reason: 'content_type_mismatch_pdf' };
  }

  else if (ct === 'application/zip') {
    const ok =
      startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
    basic = ok ? { ok: true } : { ok: false, reason: 'content_type_mismatch_zip' };
  }

  else if (ct === 'text/plain') {
    basic = looksLikeUtf8Text(bytes) ? { ok: true } : { ok: false, reason: 'content_type_mismatch_text' };
  }

  else if (ct === 'application/json') {
    if (!looksLikeUtf8Text(bytes)) {
      basic = { ok: false, reason: 'content_type_mismatch_json' };
    } else {
      const s = bytes.toString('utf8').trimStart();
      basic = s.startsWith('{') || s.startsWith('[') ? { ok: true } : { ok: false, reason: 'content_type_mismatch_json' };
    }
  }

  else if (ct === 'video/mp4') {
    // Very lightweight MP4 container sniff: [size][ftyp] box header at offset 4.
    const ok = bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
    basic = ok ? { ok: true } : { ok: false, reason: 'content_type_mismatch_mp4' };
  }

  if (!basic.ok) return basic;

  if (engine === 'clamav') {
    const av = await scanWithClamav({ bytes });
    return av.ok ? basic : av;
  }

  if (engine === 'clamd') {
    const av = await scanWithClamd({ bytes });
    return av.ok ? basic : av;
  }

  return basic;
}

async function scanWithClamd(input: { bytes: Buffer }): Promise<ScanResult> {
  const host = process.env.CLAMD_HOST ?? '127.0.0.1';
  const port = Number(process.env.CLAMD_PORT ?? 3310);
  const timeoutMs = Number(process.env.CLAMD_TIMEOUT_MS ?? 15_000);
  if (!Number.isFinite(port) || port <= 0) throw new Error('invalid_clamd_port');

  const { connect } = await import('net');

  return await new Promise<ScanResult>((resolve) => {
    let done = false;
    const finish = (res: ScanResult) => {
      if (done) return;
      done = true;
      resolve(res);
    };

    const socket = connect({ host, port }, () => {
      try {
        // clamd protocol: use the NUL-terminated "zINSTREAM" form for broad compatibility.
        // Some builds accept "INSTREAM\\n", but others only accept "zINSTREAM\\0".
        socket.write('zINSTREAM\0');
        const bytes = input.bytes;
        const chunkSize = 1024 * 1024;
        for (let off = 0; off < bytes.length; off += chunkSize) {
          const end = Math.min(bytes.length, off + chunkSize);
          const chunk = bytes.subarray(off, end);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.byteLength, 0);
          socket.write(len);
          socket.write(chunk);
        }
        const zero = Buffer.alloc(4);
        zero.writeUInt32BE(0, 0);
        socket.end(zero);
      } catch (err: any) {
        socket.destroy();
        finish({ ok: false, reason: `clamd_stream_error:${String(err?.message ?? err)}` });
      }
    });

    socket.setTimeout(timeoutMs);
    let resp = '';

    socket.on('data', (d) => {
      resp += d.toString('utf8');
    });
    socket.on('timeout', () => {
      socket.destroy();
      finish({ ok: false, reason: 'clamd_timeout' });
    });
    socket.on('error', (e: any) => {
      finish({ ok: false, reason: `clamd_error:${String(e?.message ?? e)}` });
    });
    socket.on('close', () => {
      if (done) return;
      const line = resp.trim();
      const upper = line.toUpperCase();
      if (upper.includes(' OK')) return finish({ ok: true });
      if (upper.includes('FOUND')) return finish({ ok: false, reason: 'clamd_infected' });
      if (!line) return finish({ ok: false, reason: 'clamd_no_response' });
      return finish({ ok: false, reason: `clamd_unknown:${line.slice(0, 200)}` });
    });
  });
}
