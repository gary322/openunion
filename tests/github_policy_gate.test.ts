import { describe, it, expect } from 'vitest';
import { decideRepoPolicy, readPolicyVersion } from '../src/intel/policy.js';

describe('intel policy gate', () => {
  it('blocks archived repos deterministically', () => {
    const d = decideRepoPolicy({ mode: 'suggest', licenseSpdx: 'MIT', archived: true, stars: 100 });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error('expected blocked');
    expect(d.code).toBe('policy_blocked_security');
  });

  it('blocks denylisted licenses', () => {
    const old = process.env.INTEL_LICENSE_DENYLIST;
    try {
      process.env.INTEL_LICENSE_DENYLIST = 'GPL-3.0';
      const d = decideRepoPolicy({ mode: 'suggest', licenseSpdx: 'GPL-3.0', archived: false, stars: 100 });
      expect(d.allowed).toBe(false);
      if (d.allowed) throw new Error('expected blocked');
      expect(d.code).toBe('policy_blocked_license');
    } finally {
      process.env.INTEL_LICENSE_DENYLIST = old;
    }
  });

  it('auto-apply requires explicit license (and allowlist if configured)', () => {
    const old = process.env.INTEL_LICENSE_ALLOWLIST;
    try {
      process.env.INTEL_LICENSE_ALLOWLIST = 'MIT,Apache-2.0';
      const unknown = decideRepoPolicy({ mode: 'auto_apply', licenseSpdx: null, archived: false, stars: 100 });
      expect(unknown.allowed).toBe(false);
      if (unknown.allowed) throw new Error('expected blocked');
      expect(unknown.code).toBe('policy_blocked_license');

      const notAllow = decideRepoPolicy({ mode: 'auto_apply', licenseSpdx: 'BSD-3-Clause', archived: false, stars: 100 });
      expect(notAllow.allowed).toBe(false);
      if (notAllow.allowed) throw new Error('expected blocked');
      expect(notAllow.code).toBe('policy_blocked_license');

      const ok = decideRepoPolicy({ mode: 'auto_apply', licenseSpdx: 'MIT', archived: false, stars: 100 });
      expect(ok.allowed).toBe(true);
    } finally {
      process.env.INTEL_LICENSE_ALLOWLIST = old;
    }
  });

  it('suggest mode allows unknown licenses unless allowlist is enforced', () => {
    const old = process.env.INTEL_LICENSE_ALLOWLIST;
    try {
      process.env.INTEL_LICENSE_ALLOWLIST = '';
      const d1 = decideRepoPolicy({ mode: 'suggest', licenseSpdx: null, archived: false, stars: 0 });
      expect(d1.allowed).toBe(true);

      process.env.INTEL_LICENSE_ALLOWLIST = 'MIT';
      const d2 = decideRepoPolicy({ mode: 'suggest', licenseSpdx: null, archived: false, stars: 0 });
      expect(d2.allowed).toBe(false);
      if (d2.allowed) throw new Error('expected blocked');
      expect(d2.code).toBe('policy_blocked_license');
    } finally {
      process.env.INTEL_LICENSE_ALLOWLIST = old;
    }
  });

  it('policy version changes with env knobs', () => {
    const oldAllow = process.env.INTEL_LICENSE_ALLOWLIST;
    const oldDeny = process.env.INTEL_LICENSE_DENYLIST;
    try {
      process.env.INTEL_LICENSE_ALLOWLIST = 'MIT';
      process.env.INTEL_LICENSE_DENYLIST = '';
      const v1 = readPolicyVersion();
      process.env.INTEL_LICENSE_ALLOWLIST = 'MIT,Apache-2.0';
      const v2 = readPolicyVersion();
      expect(v1).not.toBe(v2);
    } finally {
      process.env.INTEL_LICENSE_ALLOWLIST = oldAllow;
      process.env.INTEL_LICENSE_DENYLIST = oldDeny;
    }
  });
});

