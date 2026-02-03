const apiBaseDefault = window.location.origin;

export function $(id) {
  return document.getElementById(id);
}

export function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

export function getBuyerToken() {
  return localStorage.getItem('pw_buyer_token') || '';
}

export function setBuyerToken(t) {
  localStorage.setItem('pw_buyer_token', t);
}

export function getApiBase() {
  return localStorage.getItem('pw_api_base') || apiBaseDefault;
}

export function setApiBase(u) {
  localStorage.setItem('pw_api_base', u);
}

export async function buyerApi(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${getApiBase()}${path}`, {
    method,
    headers,
    // These app pages are token-authenticated; do not send cookie sessions (avoids CSRF coupling).
    credentials: 'omit',
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { res, json };
}

export async function listBountiesForTaskType(taskType, token) {
  return buyerApi(`/api/bounties?task_type=${encodeURIComponent(taskType)}&page=1&limit=50`, { token });
}

export async function listJobsForBounty(bountyId, token) {
  return buyerApi(`/api/bounties/${encodeURIComponent(bountyId)}/jobs?page=1&limit=50`, { token });
}

export function validateDescriptor(schema, desc) {
  const errs = [];
  if (!desc || typeof desc !== 'object') return ['descriptor must be an object'];
  const req = schema.required || [];
  for (const k of req) {
    if (desc[k] === undefined) errs.push(`missing ${k}`);
  }
  if (schema.properties?.schema_version?.const && desc.schema_version !== schema.properties.schema_version.const) {
    errs.push(`schema_version must be ${schema.properties.schema_version.const}`);
  }
  if (typeof desc.type !== 'string' || desc.type.length < 1 || desc.type.length > 120) {
    errs.push('type must be 1..120 chars');
  }
  const enumTags = schema.properties?.capability_tags?.items?.enum || [];
  if (!Array.isArray(desc.capability_tags) || desc.capability_tags.length < 1) {
    errs.push('capability_tags must be a non-empty array');
  } else {
    for (const t of desc.capability_tags) {
      if (!enumTags.includes(t)) errs.push(`unknown capability tag: ${t}`);
    }
  }
  if (desc.freshness_sla_sec !== undefined) {
    const v = Number(desc.freshness_sla_sec);
    if (!Number.isFinite(v) || v < 1 || v > 86400) errs.push('freshness_sla_sec must be 1..86400');
  }
  return errs;
}
