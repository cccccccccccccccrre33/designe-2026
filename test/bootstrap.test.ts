import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubApi } from '../src/github/publisher.ts';
import { listRepoFiles, publishWorkingCopy } from '../src/github/bootstrap.ts';
import { FakeGitHub } from './helpers.ts';

test('публикация рабочей копии: секреты и служебные папки не уходят, main не трогается, открыт PR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dk-boot-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules/x'), { recursive: true });
  await mkdir(join(root, '.studio-data'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# студия');
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1;');
  await writeFile(join(root, '.env'), 'GITHUB_TOKEN=секрет');
  await writeFile(join(root, 'node_modules/x/i.js'), '');
  await writeFile(join(root, '.studio-data/s.json'), '{}');
  assert.deepEqual(await listRepoFiles(root), ['README.md', 'src/a.ts']);

  const gh = new FakeGitHub();
  const res = await publishWorkingCopy(new GitHubApi('G', 'test/repo', { fetchImpl: gh.fetch }), root, { branch: 'studio-foundation', title: 'Основа', body: 'b' });
  assert.equal(res.files, 2);
  assert.equal(gh.pulls.length, 1);
  assert.equal(gh.pulls[0].head, 'studio-foundation');
  assert.equal(gh.mainFiles().get('README.md'), 'hello'); // main без изменений до merge владельцем
  const branchTree = gh.commits.get(gh.refs.get('studio-foundation')!)!.tree;
  assert.equal(branchTree.get('src/a.ts'), 'export const a = 1;');
  assert.ok(![...branchTree.keys()].some((k) => k.includes('.env') || k.includes('node_modules')));

  // Повторный запуск обновляет ту же ветку и тот же PR.
  await writeFile(join(root, 'src/a.ts'), 'export const a = 2;');
  await publishWorkingCopy(new GitHubApi('G', 'test/repo', { fetchImpl: gh.fetch }), root, { branch: 'studio-foundation', title: 'Основа', body: 'b' });
  assert.equal(gh.pulls.length, 1);
  assert.equal(gh.commits.get(gh.refs.get('studio-foundation')!)!.tree.get('src/a.ts'), 'export const a = 2;');
});
