import { $, pretty, getBuyerToken, setBuyerToken, getApiBase, setApiBase, buyerApi, listBountiesForTaskType, listJobsForBounty, validateDescriptor } from '/apps/shared.js';

async function loadSchema() {
  const res = await fetch('/contracts/task_descriptor.schema.json');
  return res.json();
}

function bytesOf(obj) {
  return new Blob([JSON.stringify(obj)]).size;
}

export async function initAppPage(cfg) {
  const schema = await loadSchema();
  $('buyerToken').value = getBuyerToken();
  $('apiBase').value = getApiBase();

  const defaultDesc = {
    schema_version: 'v1',
    type: cfg.taskType,
    capability_tags: cfg.defaultCaps,
    input_spec: cfg.defaultInputSpec || {},
    output_spec: cfg.defaultOutputSpec || {},
    ...(cfg.defaultFreshnessSlaSec ? { freshness_sla_sec: cfg.defaultFreshnessSlaSec } : {}),
  };
  $('descriptor').value = JSON.stringify(defaultDesc, null, 2);

  async function refresh() {
    const token = $('buyerToken').value.trim();
    if (!token) return;
    const { res, json } = await listBountiesForTaskType(cfg.taskType, token);
    if (!res.ok) {
      $('status').textContent = `list failed (${res.status})`;
      $('bounties').textContent = pretty(json);
      return;
    }
    $('status').textContent = `loaded ${json.bounties.length} bounties`;
    $('bounties').textContent = pretty(json);
  }

  async function createBounty(publish) {
    const token = $('buyerToken').value.trim();
    if (!token) throw new Error('missing buyer token');
    setBuyerToken(token);
    setApiBase($('apiBase').value.trim());

    let desc;
    try {
      desc = JSON.parse($('descriptor').value);
    } catch {
      $('status').textContent = 'descriptor JSON parse error';
      return;
    }
    const errs = validateDescriptor(schema, desc);
    if (errs.length) {
      $('status').textContent = `descriptor invalid: ${errs.join('; ')}`;
      return;
    }
    $('bytes').textContent = `descriptor size: ${bytesOf(desc)} B`;

    const payload = {
      title: $('title').value.trim() || `${cfg.titlePrefix} bounty`,
      description: $('description').value.trim() || cfg.description,
      allowedOrigins: $('origins').value.split(',').map((s) => s.trim()).filter(Boolean),
      payoutCents: Number($('payout').value || 0),
      requiredProofs: Number($('proofs').value || 1),
      fingerprintClassesRequired: ['desktop_us'],
      taskDescriptor: desc,
    };

    const { res, json } = await buyerApi('/api/bounties', { method: 'POST', token, body: payload });
    if (!res.ok) {
      $('status').textContent = `create failed (${res.status}): ${json?.error?.message || ''}`;
      return;
    }
    $('status').textContent = `created bounty ${json.id}`;

    if (publish) {
      const pub = await buyerApi(`/api/bounties/${encodeURIComponent(json.id)}/publish`, { method: 'POST', token });
      $('status').textContent = pub.res.ok ? `published bounty ${json.id}` : `publish failed (${pub.res.status})`;
    }

    await refresh();
  }

  async function loadJobs() {
    const token = $('buyerToken').value.trim();
    const bountyId = $('bountyId').value.trim();
    if (!token || !bountyId) return;
    const { res, json } = await listJobsForBounty(bountyId, token);
    $('jobs').textContent = pretty(json);
    $('status').textContent = res.ok ? `loaded jobs for ${bountyId}` : `jobs load failed (${res.status})`;
  }

  $('btnRefresh').addEventListener('click', () => refresh());
  $('btnCreate').addEventListener('click', () => createBounty(false));
  $('btnCreatePublish').addEventListener('click', () => createBounty(true));
  $('btnJobs').addEventListener('click', () => loadJobs());

  $('bytes').textContent = `descriptor size: ${bytesOf(defaultDesc)} B`;
  await refresh();
}
