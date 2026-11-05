#!/usr/bin/env node
// End-to-end tests: runs the CLI against an in-process mock of the Linear GraphQL API.
// No network or real API key needed. Run with: npm test
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'linear-cli.js');

const states = [
  { id: 's1', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 's2', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 's3', name: 'In Progress', type: 'started', position: 2 },
  { id: 's4', name: 'In Review', type: 'started', position: 3 },
  { id: 's5', name: 'Done', type: 'completed', position: 4 },
];
const users = [
  { id: 'u1', name: 'Yusuf A', displayName: 'yusuf', email: 'yusuf@example.com', active: true },
  { id: 'u2', name: 'Dana Lee', displayName: 'dana', email: 'dana@example.com', active: true },
  { id: 'u3', name: 'Dan Park', displayName: 'danp', email: 'danp@example.com', active: true },
];
const team = { id: 't1', key: 'TEC', name: 'Tech' };
const brief = (i) => ({ id: i.id, identifier: i.identifier, title: i.title, state: i.state });

function makeIssue(n, title, extra = {}) {
  return {
    id: `i${n}`, identifier: `TEC-${n}`, title, description: `Body of ${n}`,
    url: `https://linear.app/acme/issue/TEC-${n}`, priority: 2, priorityLabel: 'High',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    state: states[1], team, labels: { nodes: [{ name: 'bug' }] },
    assignee: null, creator: { id: 'u2', name: 'Dana Lee' },
    parent: null, children: { nodes: [] }, project: null, projectMilestone: null, cycle: null,
    relations: { nodes: [] }, inverseRelations: { nodes: [] },
    attachments: { nodes: [] },
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ...extra,
  };
}

const db = {};
db['TEC-1'] = makeIssue(1, 'Epic: checkout');
db['TEC-2'] = makeIssue(2, 'Payment form', { assignee: { id: 'u1', name: 'Yusuf A' } });
db['TEC-3'] = makeIssue(3, 'Card validation');
db['TEC-4'] = makeIssue(4, 'Backend API');
db['TEC-2'].parent = brief(db['TEC-1']);
db['TEC-3'].parent = brief(db['TEC-2']);
db['TEC-1'].children.nodes = [brief(db['TEC-2'])];
db['TEC-2'].children.nodes = [brief(db['TEC-3'])];
db['TEC-2'].project = { id: 'p1', name: 'Checkout v2', url: 'https://linear.app/acme/project/p1', state: 'started' };
db['TEC-2'].projectMilestone = { name: 'Beta' };
db['TEC-2'].cycle = { number: 7, name: null };
db['TEC-2'].relations.nodes = [{ type: 'blocks', relatedIssue: brief(db['TEC-4']) }];
db['TEC-2'].inverseRelations.nodes = [{ type: 'related', issue: brief(db['TEC-3']) }];
// TEC-5: 60 comments (needs paging), with uploads in early and late comments.
db['TEC-5'] = makeIssue(5, 'Has comment attachments');
db['TEC-5'].comments.nodes = Array.from({ length: 60 }, (_, k) => ({
  id: `c${k}`, createdAt: `2026-01-01T00:${String(k).padStart(2, '0')}:00Z`, user: { id: 'u2', name: 'Dana Lee' },
  body: k === 0 ? 'Repro: ![screenshot.png](https://uploads.linear.app/org/aaa/up-shot?signature=sig123)'
    : k === 1 ? 'Same image again https://uploads.linear.app/org/aaa/up-shot?signature=sig123. And [server.log](https://uploads.linear.app/org/bbb/up-log)'
    : k === 59 ? 'Late one ![late.png](https://uploads.linear.app/org/ccc/up-late)'
    : `comment ${k}`,
}));

// Fake storage: blobs by upload id. up-log redirects to a storage host like a signed-URL hop would.
const blobs = {
  'up-shot': { type: 'image/png', data: Buffer.from('PNGDATA-shot') },
  'up-log': { type: 'text/plain', data: Buffer.from('log lines') },
  'up-late': { type: 'image/png', data: Buffer.from('PNGDATA-late') },
};
const downloads = [];
const puts = [];
let nextId = 10;
let nextUpload = 1;
const requests = [];

// Expands parent/children links on read so nested selections resolve.
function hydrate(i, depth = 0) {
  if (!i || depth > 6) return i;
  const full = db[i.identifier] || i;
  return {
    ...full,
    team: { ...team, states: { nodes: states } },
    parent: full.parent ? hydrate(full.parent, depth + 1) : null,
    children: { nodes: (full.children?.nodes || []).map(c => hydrate(c, depth + 1)) },
  };
}

function resolve(query, v) {
  if (/viewer\s*{\s*assignedIssues/.test(query)) {
    let list = Object.values(db).filter(i => i.assignee?.id === 'u1');
    if (v.filter?.state) list = list.filter(i => !['completed', 'canceled'].includes(i.state.type));
    return { viewer: { assignedIssues: { nodes: list } } };
  }
  if (/viewer/.test(query)) return { viewer: users[0] };
  if (/searchIssues/.test(query)) {
    return { searchIssues: { nodes: Object.values(db).filter(i => i.title.toLowerCase().includes(v.term.toLowerCase())) } };
  }
  if (/teams/.test(query)) return { teams: { nodes: [team] } };
  if (/users\(/.test(query)) {
    const q = v.filter.or[0].email.eqIgnoreCase.toLowerCase();
    return { users: { nodes: users.filter(u => u.email === q || u.displayName.includes(q) || u.name.toLowerCase().includes(q)) } };
  }
  if (/issueUpdate/.test(query)) {
    const i = Object.values(db).find(x => x.id === v.id || x.identifier === v.id);
    if (v.input.stateId) i.state = states.find(s => s.id === v.input.stateId);
    if ('assigneeId' in v.input) {
      const u = users.find(u => u.id === v.input.assigneeId);
      i.assignee = u ? { id: u.id, name: u.name } : null;
    }
    return { issueUpdate: { success: true, issue: i } };
  }
  if (/issueCreate/.test(query)) {
    const n = nextId++;
    const i = makeIssue(n, v.input.title, { description: v.input.description || '' });
    if (v.input.assigneeId) i.assignee = { id: 'u1', name: 'Yusuf A' };
    db[i.identifier] = i;
    return { issueCreate: { success: true, issue: i } };
  }
  if (/commentCreate/.test(query)) {
    const i = Object.values(db).find(x => x.id === v.input.issueId);
    const c = { id: `new${i.comments.nodes.length}`, body: v.input.body, createdAt: '2026-02-01T00:00:00Z', user: { id: 'u1', name: 'Yusuf A' } };
    i.comments.nodes.push(c);
    return { commentCreate: { success: true, comment: { id: c.id } } };
  }
  if (/fileUpload/.test(query)) {
    const id = `up-new${nextUpload++}`;
    blobs[id] = { type: v.contentType, name: v.filename, size: v.size };
    return { fileUpload: { success: true, uploadFile: {
      uploadUrl: `http://127.0.0.1:${server.address().port}/put/${id}`,
      assetUrl: `https://uploads.linear.app/org/new/${id}`,
      headers: [{ key: 'x-goog-meta-test', value: 'yes' }],
    } } };
  }
  if (/comments\(first: 100, after/.test(query)) {
    const i = Object.values(db).find(x => x.id === v.id);
    const start = Number(v.after);
    return { issue: { comments: { nodes: i.comments.nodes.slice(start, start + 100), pageInfo: { hasNextPage: start + 100 < i.comments.nodes.length, endCursor: String(start + 100) } } } };
  }
  if (/issue\(id/.test(query)) {
    const i = db[v.id];
    if (!i) return { __errors: [{ message: 'Entity not found: Issue' }] };
    const h = hydrate(i);
    // Like Linear: the first page holds 50 comments
    const all = i.comments.nodes;
    h.comments = { nodes: all.slice(0, 50), pageInfo: { hasNextPage: all.length > 50, endCursor: '50' } };
    return { issue: h };
  }
  return { __errors: [{ message: 'mock: unhandled query' }] };
}

function handleFiles(req, res, raw) {
  const put = req.url.match(/^\/put\/(.+)$/);
  if (put && req.method === 'PUT') {
    const b = blobs[put[1]];
    b.data = raw;
    puts.push({ id: put[1], headers: req.headers, data: raw });
    return res.end();
  }
  const m = req.url.match(/^\/__https(\/[^?]*)(\?.*)?$/);
  const host = req.headers['x-orig-host'];
  const id = m[1].split('/').pop();
  downloads.push({ host, path: m[1], query: m[2] || '', auth: req.headers.authorization });
  if (host === 'uploads.linear.app') {
    if (req.headers.authorization !== 'test-key') { res.statusCode = 401; return res.end(); }
    if (id === 'up-log') {
      res.statusCode = 302;
      res.setHeader('Location', 'https://storage.example.com/bucket/up-log?X-Sig=abc');
      return res.end();
    }
  }
  const b = blobs[id];
  if (!b || !b.data) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', b.type);
  res.end(b.data);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url !== '/graphql') return handleFiles(req, res, Buffer.concat(chunks));
    const body = Buffer.concat(chunks).toString('utf8');
    const { query, variables } = JSON.parse(body);
    requests.push({ query, variables, auth: req.headers.authorization });
    const data = resolve(query, variables || {});
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data.__errors ? { errors: data.__errors } : { data }));
  });
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-cli-test-'));

function run(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd: opts.cwd || home,
      env: {
        PATH: process.env.PATH, HOME: home, LINEAR_API_KEY: 'test-key',
        LINEAR_API_URL: `http://127.0.0.1:${server.address().port}/graphql`,
        MOCK_PORT: String(server.address().port),
        NODE_OPTIONS: `--require ${path.join(__dirname, 'helpers', 'route-https.js')}`,
      },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('help lists new commands', async () => {
  const r = await run(['help']);
  for (const c of ['mine', 'search', 'show', 'tree', 'open', 'status', 'assign', 'create', 'teams']) assert.ok(r.stdout.includes(`  ${c}`), c);
});

test('errors are reported cleanly with exit code 1', async () => {
  const r = await run(['show', 'TEC-999']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /^Error: GraphQL error: Entity not found: Issue/);
  assert.ok(!/at .*\.js:\d+/.test(r.stderr), 'no stack trace');
});

test('mine lists open assigned issues', async () => {
  const r = await run(['mine']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /TEC-2\s+\[Todo\]\s+Payment form/);
  assert.ok(!r.stdout.includes('TEC-1'));
});

test('search finds by text', async () => {
  const r = await run(['search', 'card']);
  assert.match(r.stdout, /TEC-3/);
  const none = await run(['search', 'nothing-here']);
  assert.match(none.stdout, /No issues match/);
});

test('take writes full metadata including hierarchy', async () => {
  const r = await run(['take', 'TEC-2']);
  assert.strictEqual(r.code, 0, r.stderr);
  const folder = r.stdout.match(/^Prepared (.+)$/m)[1];
  const meta = JSON.parse(fs.readFileSync(path.join(folder, 'metadata.json'), 'utf8'));
  assert.strictEqual(meta.url, 'https://linear.app/acme/issue/TEC-2');
  assert.strictEqual(meta.state.name, 'Todo');
  assert.strictEqual(meta.parent.identifier, 'TEC-1');
  assert.deepStrictEqual(meta.children.map(c => c.identifier), ['TEC-3']);
  assert.strictEqual(meta.project.name, 'Checkout v2');
  assert.deepStrictEqual(meta.relations.map(x => `${x.type} ${x.identifier}`), ['blocks TEC-4', 'related to TEC-3']);
  const desc = fs.readFileSync(path.join(folder, 'description.md'), 'utf8');
  assert.match(desc, /Parent: TEC-1 Epic: checkout/);
  assert.match(desc, /Project: Checkout v2 \/ Beta/);
});

test('sync keeps creator/assignee in metadata (regression)', async () => {
  const r = await run(['sync', 'TEC-2']);
  assert.strictEqual(r.code, 0, r.stderr);
  const folder = r.stdout.match(/^Synced (.+)$/m)[1];
  const meta = JSON.parse(fs.readFileSync(path.join(folder, 'metadata.json'), 'utf8'));
  assert.strictEqual(meta.creator.name, 'Dana Lee');
  assert.strictEqual(meta.assignee.name, 'Yusuf A');
});

test('status lists states and fuzzy-sets one from inside the issue dir', async () => {
  const folder = (await run(['take', 'TEC-2'])).stdout.match(/^Already prepared at (.+)$/m)[1];
  const list = await run(['status'], { cwd: path.join(folder, 'attachments') });
  assert.match(list.stdout, /TEC-2 is Todo/);
  assert.match(list.stdout, /\* Todo/);
  const set = await run(['status', 'progress'], { cwd: folder });
  assert.strictEqual(set.code, 0, set.stderr);
  assert.match(set.stdout, /TEC-2: Todo → In Progress/);
  const meta = JSON.parse(fs.readFileSync(path.join(folder, 'metadata.json'), 'utf8'));
  assert.strictEqual(meta.state.name, 'In Progress', 'local metadata refreshed');
  const amb = await run(['status', 'TEC-2', 'in']);
  assert.strictEqual(amb.code, 1);
  assert.match(amb.stderr, /ambiguous: In Progress, In Review/);
});

test('assign by name, ambiguity, -me and --none', async () => {
  let r = await run(['assign', 'TEC-3', 'dana@example.com']);
  assert.match(r.stdout, /TEC-3 assigned to Dana Lee/);
  r = await run(['assign', 'TEC-3', 'dan']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /matches several users/);
  r = await run(['assign', 'TEC-3', '-me']);
  assert.match(r.stdout, /assigned to Yusuf A/);
  r = await run(['assign', 'TEC-3', '--none']);
  assert.match(r.stdout, /TEC-3 unassigned/);
  r = await run(['assign', 'TEC-3']);
  assert.strictEqual(r.code, 1);
});

test('teams and create --take', async () => {
  assert.match((await run(['teams'])).stdout, /TEC\s+Tech/);
  const r = await run(['create', 'New thing', '-d', 'details', '-me', '--take']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /Created TEC-10: New thing/);
  assert.match(r.stdout, /^Prepared .*TEC-10$/m);
  const create = requests.find(q => /issueCreate/.test(q.query));
  assert.deepStrictEqual(create.variables.input, { teamId: 't1', title: 'New thing', description: 'details', assigneeId: 'u1' });
});

test('show prints hierarchy summary', async () => {
  const r = await run(['show', 'TEC-2']);
  assert.match(r.stdout, /Parent:\s+TEC-1 Epic: checkout/);
  assert.match(r.stdout, /Sub-issues:\s+1 \(TEC-3\)/);
  assert.match(r.stdout, /Relations:\s+blocks TEC-4, related to TEC-3/);
});

test('tree shows project, ancestors, children and relations', async () => {
  const r = await run(['tree', 'TEC-3']);
  assert.strictEqual(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.ok(lines.indexOf('TEC-1 Epic: checkout [Todo]') >= 0, r.stdout);
  assert.ok(lines.some(l => /^  TEC-2 Payment form/.test(l)));
  assert.ok(lines.some(l => /▶ TEC-3 Card validation/.test(l)));
  const top = await run(['tree', 'TEC-1', '--depth', '3']);
  assert.match(top.stdout, /└── TEC-2 Payment form/);
  assert.match(top.stdout, /    └── TEC-3 Card validation/);
  const mid = await run(['tree', 'TEC-2']);
  assert.match(mid.stdout, /^Project: Checkout v2 \/ Beta/m);
  assert.match(mid.stdout, /^Cycle:   Cycle 7/m);
  assert.match(mid.stdout, /blocks\s+TEC-4 Backend API/);
  assert.match(mid.stdout, /related to\s+TEC-3 Card validation/);
});

test('comment attachments download: dedupe, signed URLs, redirects, paging', async () => {
  downloads.length = 0;
  const r = await run(['take', 'TEC-5']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(!/Warning/.test(r.stderr), r.stderr);
  const folder = r.stdout.match(/^Prepared (.+)$/m)[1];
  const dir = path.join(folder, 'attachments', 'comments');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'screenshot.png'), 'utf8'), 'PNGDATA-shot');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'server.log'), 'utf8'), 'log lines');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'late.png'), 'utf8'), 'PNGDATA-late', 'comment 60 (second page) downloaded');
  assert.strictEqual(downloads.filter(d => d.path.endsWith('up-shot')).length, 1, 'same upload fetched once');
  assert.strictEqual(downloads.find(d => d.path.endsWith('up-shot')).query, '?signature=sig123', 'signed query kept for download');
  const storage = downloads.find(d => d.host === 'storage.example.com');
  assert.ok(storage, 'redirect followed');
  assert.strictEqual(storage.auth, undefined, 'API key not sent to the redirect host');
  const md = fs.readFileSync(path.join(folder, 'comments.md'), 'utf8');
  assert.match(md, /!\[screenshot\.png\]\(attachments\/comments\/screenshot\.png\)/);
  assert.match(md, /Same image again attachments\/comments\/screenshot\.png\. And/);
  assert.match(md, /\[server\.log\]\(attachments\/comments\/server\.log\)/);
  assert.ok(!md.includes('signature='), 'no dangling signed query in local links');
  assert.ok(!md.includes('uploads.linear.app'), 'all upload links rewritten');
});

test('download failures are reported, not silent', async () => {
  db['TEC-6'] = makeIssue(6, 'Broken upload', { description: '![gone.png](https://uploads.linear.app/org/x/up-missing)' });
  const r = await run(['take', 'TEC-6']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stderr, /Warning: 1 attachment\(s\) could not be downloaded:\n  gone\.png: download failed with HTTP 404/);
});

test('create uploads files linked from local markdown and --attach, then take pulls them back', async () => {
  const work = fs.mkdtempSync(path.join(home, 'draft-'));
  fs.mkdirSync(path.join(work, 'img'));
  fs.writeFileSync(path.join(work, 'img', 'shot one.png'), 'LOCALPNG');
  fs.writeFileSync(path.join(work, 'spec.pdf'), 'LOCALPDF');
  fs.writeFileSync(path.join(work, 'extra.log'), 'EXTRALOG');
  fs.writeFileSync(path.join(work, 'issue.md'), [
    'Steps:',
    '![shot](<img/shot one.png>)',
    'See [the spec](./spec.pdf "Spec") and [again](spec.pdf).',
    'Missing: ![m](missing.png)',
    'Web: ![w](https://example.com/w.png) [anchor](#steps)',
    '```',
    '![code](./img/shot one.png)',
    '```',
  ].join('\n'));
  puts.length = 0;
  const r = await run(['create', 'With files', '-f', path.join(work, 'issue.md'), '-a', path.join(work, 'extra.log'), '--take']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stderr, /Warning: missing\.png not found/);
  assert.strictEqual(puts.length, 3, 'shot, spec (once), extra.log');
  assert.deepStrictEqual(puts.map(p => p.data.toString()).sort(), ['EXTRALOG', 'LOCALPDF', 'LOCALPNG']);
  const png = puts.find(p => p.data.toString() === 'LOCALPNG');
  assert.strictEqual(png.headers['content-type'], 'image/png');
  assert.strictEqual(png.headers['x-goog-meta-test'], 'yes', 'headers from fileUpload are sent');
  const created = Object.values(db).find(i => i.title === 'With files');
  const d = created.description;
  assert.match(d, /!\[shot\]\(https:\/\/uploads\.linear\.app\/org\/new\/up-new\d+\)/);
  assert.match(d, /\[the spec\]\(https:\/\/uploads\.linear\.app\/org\/new\/up-new\d+ "Spec"\)/);
  assert.match(d, /!\[m\]\(missing\.png\)/, 'missing file left alone');
  assert.match(d, /!\[w\]\(https:\/\/example\.com\/w\.png\) \[anchor\]\(#steps\)/);
  assert.match(d, /```\n!\[code\]\(\.\/img\/shot one\.png\)\n```/, 'code block untouched');
  assert.match(d, /\n\n\[extra\.log\]\(https:\/\/uploads\.linear\.app\/org\/new\/up-new\d+\)\n$/);
  // Round trip: --take downloaded the uploads back into the new issue folder
  const folder = r.stdout.match(/^Prepared (.+)$/m)[1];
  const files = fs.readdirSync(path.join(folder, 'attachments')).sort();
  assert.ok(files.includes('index.csv'));
  assert.strictEqual(files.filter(f => f !== 'index.csv').length, 3, files.join(','));
  assert.ok(!fs.readFileSync(path.join(folder, 'description.md'), 'utf8').includes('uploads.linear.app'));
});

test('comments -m with a local image and -a uploads both', async () => {
  const work = fs.mkdtempSync(path.join(home, 'c-'));
  fs.writeFileSync(path.join(work, 'a.png'), 'APNG');
  fs.writeFileSync(path.join(work, 'b.txt'), 'BTXT');
  puts.length = 0;
  const r = await run(['comments', 'TEC-4', '-m', 'see ![a](./a.png)', '-a', 'b.txt'], { cwd: work });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(puts.length, 2);
  const body = db['TEC-4'].comments.nodes.slice(-1)[0].body;
  assert.match(body, /^see !\[a\]\(https:\/\/uploads\.linear\.app\/org\/new\/up-new\d+\)\n\n\[b\.txt\]\(https:\/\/uploads/);
  const only = await run(['comments', 'TEC-4', '-a', 'a.png'], { cwd: work });
  assert.strictEqual(only.code, 0, only.stderr);
  assert.match(db['TEC-4'].comments.nodes.slice(-1)[0].body, /^!\[a\.png\]\(https:\/\/uploads/);
});

test('unit: extractIssueCode and pickMatch', async () => {
  const { extractIssueCode, pickMatch } = require(CLI);
  assert.strictEqual(extractIssueCode('https://linear.app/acme/issue/TEC-42/some-title'), 'TEC-42');
  const s = [{ name: 'Todo' }, { name: 'In Progress' }, { name: 'In Review' }];
  assert.strictEqual(pickMatch(s, 'todo', x => [x.name]).match.name, 'Todo');
  assert.strictEqual(pickMatch(s, 'review', x => [x.name]).match.name, 'In Review');
  assert.strictEqual(pickMatch(s, 'in', x => [x.name]).candidates.length, 2);
});

server.listen(0, '127.0.0.1', async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${t.name}\n     ${e.message.split('\n').join('\n     ')}`);
    }
  }
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
});
