// Поддельные Telegram и GitHub в памяти + временная копия репозитория для тестов.

import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Копия рабочих каталогов репозитория: тесты пишут решения и предпочтения сюда. */
export async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dk-studio-'));
  for (const d of ['studio', 'design-system', 'knowledge', 'product']) await cp(join(REPO, d), join(dir, d), { recursive: true });
  return dir;
}

export interface TgCall {
  method: string;
  params: Record<string, unknown>;
  files: string[];
}

/** Поддельный Bot API: записывает вызовы, умеет падать заданное число раз. */
export class FakeTelegram {
  calls: TgCall[] = [];
  failNext = 0;
  private messageId = 100;

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = url.split('/').pop()!;
    if (this.failNext > 0) {
      this.failNext--;
      return new Response(JSON.stringify({ ok: false, description: 'Bad Gateway' }), { status: 502 });
    }
    const params: Record<string, unknown> = {};
    const files: string[] = [];
    if (init?.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) {
        if (typeof v === 'string') params[k] = k === 'reply_markup' || k === 'media' ? JSON.parse(v) : v;
        else files.push(k);
      }
    } else if (typeof init?.body === 'string') {
      Object.assign(params, JSON.parse(init.body));
    }
    this.calls.push({ method, params, files });
    let result: unknown = true;
    if (method === 'sendMessage' || method === 'sendPhoto') result = { message_id: ++this.messageId };
    if (method === 'sendMediaGroup') result = (params.media as unknown[]).map(() => ({ message_id: ++this.messageId }));
    if (method === 'getUpdates') result = [];
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };

  texts(): string[] {
    return this.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.params.text));
  }

  /** Последняя клавиатура с кнопками решения по версии. */
  lastApprovalKeyboard(): Array<{ text: string; callback_data: string }> {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const kb = this.calls[i].params.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined;
      const flat = kb?.inline_keyboard?.flat() ?? [];
      if (flat.some((b) => b.callback_data?.startsWith('a:'))) return flat;
    }
    return [];
  }

  cards(): TgCall[] {
    return this.calls.filter((c) => c.method === 'sendPhoto' || c.method === 'sendMediaGroup');
  }
}

interface FakeCommit {
  sha: string;
  tree: Map<string, string>;
  parents: string[];
  message: string;
}

/** Поддельный GitHub: ветки, коммиты, PR, merge — ровно те вызовы, что делает Publisher. */
export class FakeGitHub {
  refs = new Map<string, string>();
  commits = new Map<string, FakeCommit>();
  blobs = new Map<string, string>();
  trees = new Map<string, Map<string, string>>();
  pulls: Array<{ number: number; head: string; base: string; title: string; body: string; state: 'open' | 'closed'; merged: boolean; html_url: string; labels: string[] }> = [];
  private seq = 0;
  requests: string[] = [];

  constructor() {
    const root: FakeCommit = { sha: this.id(), tree: new Map([['README.md', 'hello']]), parents: [], message: 'init' };
    this.commits.set(root.sha, root);
    this.refs.set('main', root.sha);
  }

  private id(): string {
    return (++this.seq).toString(16).padStart(8, '0');
  }

  /** Файлы основной ветки после всех merge. */
  mainFiles(): Map<string, string> {
    return this.commits.get(this.refs.get('main')!)!.tree;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    this.requests.push(`${method} ${path}`);
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    let m: RegExpMatchArray | null;
    if (method === 'GET' && path === '') return json(200, { default_branch: 'main' });
    if (method === 'GET' && (m = path.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const sha = this.refs.get(decodeURIComponent(m[1]));
      return sha ? json(200, { object: { sha } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && path === '/git/refs') {
      this.refs.set(body.ref.replace('refs/heads/', ''), body.sha);
      return json(201, {});
    }
    if (method === 'GET' && (m = path.match(/^\/git\/commits\/(.+)$/))) {
      const c = this.commits.get(m[1])!;
      const treeSha = this.id();
      this.trees.set(treeSha, new Map(c.tree));
      return json(200, { tree: { sha: treeSha } });
    }
    if (method === 'POST' && path === '/git/blobs') {
      const sha = this.id();
      this.blobs.set(sha, Buffer.from(body.content, 'base64').toString('utf8'));
      return json(201, { sha });
    }
    if (method === 'POST' && path === '/git/trees') {
      const tree = new Map(this.trees.get(body.base_tree));
      for (const e of body.tree) tree.set(e.path, this.blobs.get(e.sha)!);
      const sha = this.id();
      this.trees.set(sha, tree);
      return json(201, { sha });
    }
    if (method === 'POST' && path === '/git/commits') {
      const sha = this.id();
      this.commits.set(sha, { sha, tree: this.trees.get(body.tree)!, parents: body.parents, message: body.message });
      return json(201, { sha });
    }
    if (method === 'PATCH' && (m = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
      this.refs.set(decodeURIComponent(m[1]), body.sha);
      return json(200, {});
    }
    if (method === 'GET' && path === '/pulls') {
      const head = url.searchParams.get('head')!.split(':')[1];
      return json(200, this.pulls.filter((p) => p.state === 'open' && p.head === head));
    }
    if (method === 'POST' && path === '/pulls') {
      const number = this.pulls.length + 1;
      const pr = { number, head: body.head, base: body.base, title: body.title, body: body.body, state: 'open' as const, merged: false, html_url: `https://github.com/test/repo/pull/${number}`, labels: [] as string[] };
      this.pulls.push(pr);
      return json(201, pr);
    }
    if (method === 'PATCH' && (m = path.match(/^\/pulls\/(\d+)$/))) {
      const pr = this.pulls[Number(m[1]) - 1];
      Object.assign(pr, body);
      return json(200, pr);
    }
    if (method === 'POST' && (m = path.match(/^\/issues\/(\d+)\/labels$/))) {
      this.pulls[Number(m[1]) - 1].labels.push(...body.labels);
      return json(200, {});
    }
    if (method === 'GET' && (m = path.match(/^\/pulls\/(\d+)\/files$/))) {
      const pr = this.pulls[Number(m[1]) - 1];
      const head = this.commits.get(this.refs.get(pr.head)!)!.tree;
      const base = this.commits.get(this.refs.get(pr.base)!)!.tree;
      return json(200, [...head.keys()].filter((k) => head.get(k) !== base.get(k)).map((filename) => ({ filename })));
    }
    if (method === 'PUT' && (m = path.match(/^\/pulls\/(\d+)\/merge$/))) {
      const pr = this.pulls[Number(m[1]) - 1];
      const head = this.commits.get(this.refs.get(pr.head)!)!;
      const sha = this.id();
      this.commits.set(sha, { sha, tree: new Map(head.tree), parents: [this.refs.get(pr.base)!], message: body.commit_title });
      this.refs.set(pr.base, sha);
      pr.state = 'closed';
      pr.merged = true;
      return json(200, { merged: true });
    }
    return json(404, { message: `fake: ${method} ${path}` });
  };
}

export function update(id: number, from: number, text: string) {
  return { update_id: id, message: { message_id: id, from: { id: from }, chat: { id: from }, text } };
}

export function callback(id: number, from: number, data: string) {
  return { update_id: id, callback_query: { id: `cb${id}`, from: { id: from }, data, message: { message_id: 1, chat: { id: from } } } };
}
