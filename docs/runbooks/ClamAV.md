# ClamAV (clamd) runbook

### Architecture
- The scanner worker runs with `SCANNER_ENGINE=clamd`.
- A `clamd` sidecar/container listens on TCP `3310` in the same task/network.
- Scanner streams bytes to clamd via the `INSTREAM` protocol (see `src/scanner.ts`).

### Common failure modes
- **clamd not ready** (definitions still updating): scans time out (`clamd_timeout`).
  - Mitigation: increase `CLAMD_TIMEOUT_MS`, confirm clamd logs, allow warm-up time after deploy.
- **network / connection refused**: scanner returns `clamd_error:...`.
  - Mitigation: ensure sidecar is in the same task, port 3310 exposed, env `CLAMD_HOST=127.0.0.1`, `CLAMD_PORT=3310`.
- **false positives / signature issues**:
  - Mitigation: pin image version, monitor clamd updates, add allowlists as needed.

### Validating in staging
- Upload a clean text file → expect artifact moves **staging → clean**.
- Upload the EICAR string as `text/plain` → expect artifact moves **staging → quarantine** and download is blocked.

