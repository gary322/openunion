import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import Ajv from 'ajv';

const schema = JSON.parse(readFileSync(path.join(process.cwd(), 'contracts/task_descriptor.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validate = ajv.compile(schema);

function loadFixture(name: string) {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/task_descriptors', name), 'utf8'));
}

describe('task_descriptor JSON Schema', () => {
  it('accepts a valid descriptor', () => {
    const fixtures = [
      'valid_clips.json',
      'valid_marketplace.json',
      'valid_jobs.json',
      'valid_travel.json',
      'valid_arxiv.json',
      'valid_github.json',
    ];

    for (const f of fixtures) {
      const data = loadFixture(f);
      const ok = validate(data);
      if (!ok) console.error({ fixture: f, errors: validate.errors });
      expect(ok).toBe(true);
    }
  });

  it('rejects unknown capability tag', () => {
    const data = loadFixture('invalid_tag.json');
    const ok = validate(data);
    expect(ok).toBe(false);
  });
});
