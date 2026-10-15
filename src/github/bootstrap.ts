// Первичная публикация рабочей копии в GitHub без установленного git: все файлы
// (кроме игнорируемых) одним коммитом в отдельную ветку и PR в основную.
// Запускает владелец командой `npm run studio -- publish-repo`; бот этим не пользуется.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { GitHubApi } from './publisher.ts';

const IGNORED = ['node_modules', '.studio-data', '.demo', '.tmp', '.env', '.git'];

export async function listRepoFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (IGNORED.includes(entry.name) || entry.name.endsWith('.log')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(root, full).replace(/\\/g, '/'));
    }
  }
  await walk(root);
  return out.sort();
}

export async function publishWorkingCopy(gh: GitHubApi, root: string, opts: { branch: string; title: string; body: string }): Promise<{ prUrl: string; files: number; commitSha: string }> {
  const repo = (await gh.req<{ default_branch: string }>('GET', gh.r(''))).data;
  const base = repo.default_branch;
  const baseRef = await gh.req<{ object?: { sha: string } }>('GET', gh.r(`/git/ref/heads/${base}`), undefined, [404, 409]);
  if (baseRef.status !== 200) throw new Error(`Основная ветка ${base} пуста или не найдена — создайте в репозитории хотя бы README`);
  const baseSha = baseRef.data.object!.sha;
  const existing = await gh.req<{ object?: { sha: string } }>('GET', gh.r(`/git/ref/heads/${opts.branch}`), undefined, [404]);
  if (existing.status === 404) await gh.req('POST', gh.r('/git/refs'), { ref: `refs/heads/${opts.branch}`, sha: baseSha });
  const parent = existing.status === 404 ? baseSha : existing.data.object!.sha;
  const parentTree = (await gh.req<{ tree: { sha: string } }>('GET', gh.r(`/git/commits/${parent}`))).data.tree.sha;

  const files = await listRepoFiles(root);
  const tree = [];
  for (const path of files) {
    const bytes = await readFile(join(root, path));
    const blob = (await gh.req<{ sha: string }>('POST', gh.r('/git/blobs'), { content: bytes.toString('base64'), encoding: 'base64' })).data;
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = (await gh.req<{ sha: string }>('POST', gh.r('/git/trees'), { base_tree: parentTree, tree })).data;
  const commit = (await gh.req<{ sha: string }>('POST', gh.r('/git/commits'), { message: opts.title, tree: newTree.sha, parents: [parent] })).data;
  await gh.req('PATCH', gh.r(`/git/refs/heads/${opts.branch}`), { sha: commit.sha });

  const owner = gh.repo.split('/')[0];
  const open = (await gh.req<Array<{ html_url: string }>>('GET', gh.r(`/pulls?state=open&head=${owner}:${encodeURIComponent(opts.branch)}`))).data;
  const pr = open[0] ?? (await gh.req<{ html_url: string }>('POST', gh.r('/pulls'), { title: opts.title, head: opts.branch, base, body: opts.body })).data;
  return { prUrl: pr.html_url, files: files.length, commitSha: commit.sha };
}
