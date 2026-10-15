// GitHub как система записи решений (ADR-0004). Бот работает только в ветках
// studio/*, открывает PR и вливает его сам лишь после явного одобрения владельца и
// только если PR меняет разрешённые пути (studio/, design-system/).
// Статус: модульные тесты с поддельным GitHub API; к реальному репозиторию не
// подключался — designe-2026 недоступен без авторизации.

import { readFile } from 'node:fs/promises';
import { PolicyViolation } from '../core/errors.ts';

type FetchLike = typeof fetch;

export interface PublishFile {
  path: string;
  content?: string;
  source?: string;
}

export interface MergePolicy {
  autoMergePaths: string[];
  neverAutoMergePaths: string[];
}

export class GitHubApi {
  private token: string;
  repo: string;
  private base: string;
  private fetchImpl: FetchLike;

  constructor(token: string, repo: string, opts: { baseUrl?: string; fetchImpl?: FetchLike } = {}) {
    if (!token) throw new Error('GITHUB_TOKEN не задан');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPO должен быть вида owner/name');
    this.token = token;
    this.repo = repo;
    this.base = opts.baseUrl ?? 'https://api.github.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async req<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; data: T }> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'drive-kava-studio',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as T;
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new Error(`GitHub ${method} ${path}: ${res.status} ${(data as { message?: string }).message ?? ''}`);
    }
    return { status: res.status, data };
  }

  r(path: string): string {
    return `/repos/${this.repo}${path}`;
  }
}

export function assertAutoMergeAllowed(paths: string[], policy: MergePolicy): void {
  const bad = paths.filter((p) => policy.neverAutoMergePaths.some((n) => p === n || p.startsWith(n)) || !policy.autoMergePaths.some((a) => p.startsWith(a)));
  if (bad.length) throw new PolicyViolation(`Автоматический merge запрещён для путей: ${bad.join(', ')}`, { paths: bad });
}

export class Publisher {
  private gh: GitHubApi;
  private policy: MergePolicy;

  constructor(gh: GitHubApi, policy: MergePolicy) {
    this.gh = gh;
    this.policy = policy;
  }

  private async defaultBranch(): Promise<string> {
    return (await this.gh.req<{ default_branch: string }>('GET', this.gh.r(''))).data.default_branch;
  }

  private async headSha(branch: string): Promise<string | null> {
    const res = await this.gh.req<{ object?: { sha: string } }>('GET', this.gh.r(`/git/ref/heads/${branch}`), undefined, [404]);
    return res.status === 404 ? null : res.data.object!.sha;
  }

  private async ensureBranch(branch: string, base: string): Promise<string> {
    const existing = await this.headSha(branch);
    if (existing) return existing;
    const baseSha = await this.headSha(base);
    if (!baseSha) throw new Error(`Нет базовой ветки ${base}`);
    await this.gh.req('POST', this.gh.r('/git/refs'), { ref: `refs/heads/${branch}`, sha: baseSha });
    return baseSha;
  }

  /** Один коммит с набором файлов в ветку через Git Data API. */
  async commitFiles(branch: string, files: PublishFile[], message: string): Promise<string> {
    for (const f of files) {
      if (!f.path.startsWith('studio/') && !f.path.startsWith('design-system/')) throw new PolicyViolation(`Бот не пишет за пределами studio/ и design-system/: ${f.path}`);
    }
    const parent = await this.headSha(branch);
    if (!parent) throw new Error(`Ветка ${branch} не найдена`);
    const parentCommit = (await this.gh.req<{ tree: { sha: string } }>('GET', this.gh.r(`/git/commits/${parent}`))).data;
    const tree = [];
    for (const f of files) {
      const bytes = f.content !== undefined ? Buffer.from(f.content, 'utf8') : await readFile(f.source!);
      const blob = (await this.gh.req<{ sha: string }>('POST', this.gh.r('/git/blobs'), { content: bytes.toString('base64'), encoding: 'base64' })).data;
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = (await this.gh.req<{ sha: string }>('POST', this.gh.r('/git/trees'), { base_tree: parentCommit.tree.sha, tree })).data;
    const commit = (await this.gh.req<{ sha: string }>('POST', this.gh.r('/git/commits'), { message, tree: newTree.sha, parents: [parent] })).data;
    await this.gh.req('PATCH', this.gh.r(`/git/refs/heads/${branch}`), { sha: commit.sha });
    return commit.sha;
  }

  private async findOpenPr(branch: string): Promise<{ number: number; html_url: string } | null> {
    const owner = this.gh.repo.split('/')[0];
    const list = (await this.gh.req<Array<{ number: number; html_url: string }>>('GET', this.gh.r(`/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`))).data;
    return list[0] ?? null;
  }

  async publishVersion(p: { initiativeId: string; version: number; title: string; body: string; files: PublishFile[] }): Promise<{ prUrl: string; prNumber: number; branch: string; commitSha: string }> {
    const base = await this.defaultBranch();
    const branch = `studio/${p.initiativeId}`;
    await this.ensureBranch(branch, base);
    const commitSha = await this.commitFiles(branch, p.files, `studio: ${p.title}`);
    const body = `${p.body}\n\n---\nСоздано DRIVE&KAVA Studio. Решение принимает владелец в Telegram; бот вливает PR только после явного одобрения и только для путей studio/ и design-system/.`;
    let pr = await this.findOpenPr(branch);
    if (pr) {
      await this.gh.req('PATCH', this.gh.r(`/pulls/${pr.number}`), { title: p.title, body });
    } else {
      pr = (await this.gh.req<{ number: number; html_url: string }>('POST', this.gh.r('/pulls'), { title: p.title, head: branch, base, body })).data;
      await this.gh.req('POST', this.gh.r(`/issues/${pr.number}/labels`), { labels: ['studio:awaiting-owner'] }, [404, 422]);
    }
    return { prUrl: pr.html_url, prNumber: pr.number, branch, commitSha };
  }

  async recordDecision(p: { initiativeId: string; decision: 'approved' | 'rejected'; files: PublishFile[]; version: number }): Promise<{ merged: boolean; prUrl?: string }> {
    const base = await this.defaultBranch();
    if (p.decision === 'approved') {
      const branch = `studio/${p.initiativeId}`;
      await this.ensureBranch(branch, base);
      await this.commitFiles(branch, p.files, `studio: решение владельца — одобрено v${p.version}`);
      const pr = await this.findOpenPr(branch);
      if (!pr) throw new Error(`Нет открытого PR для ${branch}`);
      await this.mergeGuarded(pr.number, `Одобрено владельцем: ${p.initiativeId} v${p.version}`);
      return { merged: true, prUrl: pr.html_url };
    }
    // Отклонение: решение и урок — отдельным PR в основную ветку, PR дизайна закрывается.
    const recordsBranch = `studio/records-${p.initiativeId}-v${p.version}`;
    await this.ensureBranch(recordsBranch, base);
    await this.commitFiles(recordsBranch, p.files, `studio: решение владельца — отклонено v${p.version}`);
    const pr = (await this.gh.req<{ number: number; html_url: string }>('POST', this.gh.r('/pulls'), { title: `Решение: отклонено ${p.initiativeId} v${p.version}`, head: recordsBranch, base, body: 'Запись решения владельца и урока. Только studio/decisions и studio/lessons.' })).data;
    await this.mergeGuarded(pr.number, `Решение владельца: отклонено ${p.initiativeId}`);
    const design = await this.findOpenPr(`studio/${p.initiativeId}`);
    if (design) await this.gh.req('PATCH', this.gh.r(`/pulls/${design.number}`), { state: 'closed' });
    return { merged: true, prUrl: pr.html_url };
  }

  /** Merge только после проверки списка файлов PR по политике путей. */
  async mergeGuarded(prNumber: number, title: string): Promise<void> {
    const files = (await this.gh.req<Array<{ filename: string }>>('GET', this.gh.r(`/pulls/${prNumber}/files?per_page=100`))).data;
    assertAutoMergeAllowed(files.map((f) => f.filename), this.policy);
    await this.gh.req('PUT', this.gh.r(`/pulls/${prNumber}/merge`), { merge_method: 'squash', commit_title: title });
  }
}
