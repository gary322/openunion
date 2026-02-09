type GithubSearchItem = {
  id?: number;
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  archived?: boolean;
  pushed_at?: string | null;
  updated_at?: string | null;
  language?: string | null;
  topics?: string[];
  license?: { spdx_id?: string | null; key?: string | null } | null;
};

export type GithubRepoSnapshot = {
  repoId: number;
  fullName: string;
  htmlUrl: string;
  description: string | null;
  language: string | null;
  topics: string[];
  licenseSpdx: string | null;
  licenseKey: string | null;
  stars: number;
  forks: number;
  archived: boolean;
  pushedAt: Date | null;
  updatedAt: Date | null;
};

function sanitizeQueryTokens(q: string): string[] {
  const s = String(q ?? '').trim();
  if (!s) return [];
  return s
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);
}

export function buildGithubSearchQuery(input: {
  query: string;
  minStars?: number;
  languages?: string[];
  licenseAllow?: string[];
}): string {
  const tokens = sanitizeQueryTokens(input.query);
  if (!tokens.length) return '';

  const qParts: string[] = [];
  qParts.push(tokens.join(' '));
  qParts.push('fork:false');

  const minStars = Number.isFinite(Number(input.minStars)) ? Math.max(0, Math.floor(Number(input.minStars))) : 0;
  if (minStars > 0) qParts.push(`stars:>=${minStars}`);

  const languages = Array.isArray(input.languages) ? input.languages.map((l) => String(l)).filter(Boolean).slice(0, 3) : [];
  for (const l of languages) qParts.push(`language:${l}`);

  const license = Array.isArray(input.licenseAllow) ? String(input.licenseAllow[0] ?? '').trim() : '';
  if (license) qParts.push(`license:${license}`);

  return qParts.join(' ').trim();
}

function parseDateOrNull(s: any): Date | null {
  const v = String(s ?? '').trim();
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function fetchGithubRepoSearch(input: {
  baseUrl: string;
  q: string;
  perPage?: number;
  token?: string | null;
  timeoutMs?: number;
}): Promise<GithubRepoSnapshot[]> {
  const base = String(input.baseUrl ?? '').trim().replace(/\/$/, '');
  if (!base) throw new Error('github_search_missing_base_url');
  const q = String(input.q ?? '').trim();
  if (!q) return [];

  const perPage = Number.isFinite(Number(input.perPage)) ? Math.max(1, Math.min(50, Math.floor(Number(input.perPage)))) : 10;
  const url = new URL(`${base}/search/repositories`);
  url.searchParams.set('q', q);
  url.searchParams.set('sort', 'stars');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(perPage));

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'proofwork-intel',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const t = String(input.token ?? '').trim();
  if (t) headers.Authorization = `Bearer ${t}`;

  const ac = new AbortController();
  const timeoutMs = Number.isFinite(Number(input.timeoutMs)) ? Math.max(1_000, Math.min(60_000, Math.floor(Number(input.timeoutMs)))) : 25_000;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    const resp = await fetch(url.toString(), { method: 'GET', headers, signal: ac.signal });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`github_search_failed:${resp.status}:${String(text || '').slice(0, 200)}`);
    const json = text ? JSON.parse(text) : null;
    const items: GithubSearchItem[] = Array.isArray(json?.items) ? json.items : [];

    const out: GithubRepoSnapshot[] = [];
    for (const it of items) {
      const repoId = Number(it?.id ?? NaN);
      const fullName = String(it?.full_name ?? '').trim();
      const htmlUrl = String(it?.html_url ?? '').trim();
      if (!Number.isFinite(repoId) || repoId <= 0 || !fullName || !htmlUrl) continue;

      const stars = Number(it?.stargazers_count ?? 0);
      const forks = Number(it?.forks_count ?? 0);
      const licenseSpdx = it?.license?.spdx_id ? String(it.license.spdx_id).trim() : null;
      const licenseKey = it?.license?.key ? String(it.license.key).trim() : null;

      out.push({
        repoId: Math.floor(repoId),
        fullName,
        htmlUrl,
        description: it?.description ? String(it.description) : null,
        language: it?.language ? String(it.language) : null,
        topics: Array.isArray(it?.topics) ? it.topics.map((x) => String(x)).filter(Boolean).slice(0, 50) : [],
        licenseSpdx: licenseSpdx || null,
        licenseKey: licenseKey || null,
        stars: Number.isFinite(stars) ? Math.max(0, Math.floor(stars)) : 0,
        forks: Number.isFinite(forks) ? Math.max(0, Math.floor(forks)) : 0,
        archived: Boolean(it?.archived ?? false),
        pushedAt: parseDateOrNull((it as any)?.pushed_at),
        updatedAt: parseDateOrNull((it as any)?.updated_at),
      });
      if (out.length >= perPage) break;
    }

    return out;
  } finally {
    clearTimeout(timer);
  }
}

