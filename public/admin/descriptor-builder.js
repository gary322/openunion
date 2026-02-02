async function loadSchema() {
  const res = await fetch('/contracts/task_descriptor.schema.json');
  return res.json();
}

const schema = await loadSchema();

const els = (id) => document.getElementById(id);

function updatePreview(desc) {
  const text = JSON.stringify(desc, null, 2);
  els('preview').textContent = text;
  els('bytes').textContent = `size: ${new Blob([text]).size} B`;
}

function safeParseJSON(txt) {
  if (!txt) return undefined;
  try {
    return JSON.parse(txt);
  } catch {
    return undefined;
  }
}

function buildDescriptor() {
  const caps = Array.from(els('caps').selectedOptions).map((o) => o.value);
  const input_spec = safeParseJSON(els('input_spec').value.trim()) || {};
  const output_spec = safeParseJSON(els('output_spec').value.trim()) || {};
  const site_profile = safeParseJSON(els('site_profile').value.trim());
  const freshness = els('freshness').value ? Number(els('freshness').value) : undefined;
  const desc = {
    schema_version: 'v1',
    type: 'custom_task',
    capability_tags: caps,
    input_spec,
    output_spec,
    ...(freshness ? { freshness_sla_sec: freshness } : {}),
    ...(site_profile ? { site_profile } : {}),
  };
  return desc;
}

function validateDescriptor(desc) {
  const errs = [];
  if (!desc || typeof desc !== 'object') return ['descriptor must be an object'];
  const required = schema.required || [];
  for (const k of required) {
    if (desc[k] === undefined) errs.push(`missing ${k}`);
  }
  const sv = schema.properties?.schema_version?.const;
  if (sv && desc.schema_version !== sv) errs.push(`schema_version must be ${sv}`);
  if (typeof desc.type !== 'string' || desc.type.length < 1 || desc.type.length > 120) errs.push('type must be 1..120 chars');
  const enumTags = schema.properties?.capability_tags?.items?.enum || [];
  if (!Array.isArray(desc.capability_tags) || desc.capability_tags.length < 1) errs.push('capability_tags must be non-empty');
  else {
    for (const t of desc.capability_tags) if (!enumTags.includes(t)) errs.push(`unknown capability tag: ${t}`);
  }
  if (desc.freshness_sla_sec !== undefined) {
    const v = Number(desc.freshness_sla_sec);
    if (!Number.isFinite(v) || v < 1 || v > 86400) errs.push('freshness_sla_sec must be 1..86400');
  }
  return errs;
}

async function submit() {
  els('error').textContent = '';
  const descriptor = buildDescriptor();
  const errs = validateDescriptor(descriptor);
  if (errs.length) {
    els('error').textContent = errs.join('; ');
    updatePreview(descriptor);
    return;
  }

  updatePreview(descriptor);
  const payload = {
    title: els('title').value,
    description: els('description').value,
    allowedOrigins: els('origins').value.split(',').map((s) => s.trim()).filter(Boolean),
    payoutCents: Number(els('payout').value || 0),
    requiredProofs: Number(els('proofs').value || 1),
    fingerprintClassesRequired: ['desktop_us'],
    taskDescriptor: descriptor,
  };
  const resp = await fetch(`${els('base').value}/api/bounties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${els('token').value}` },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    els('error').textContent = `Error ${resp.status}: ${body?.error?.message || resp.statusText}`;
    return;
  }
  const bounty = await resp.json();
  els('error').textContent = `Created bounty ${bounty.id}`;
}

document.getElementById('build').addEventListener('click', submit);
updatePreview({});
