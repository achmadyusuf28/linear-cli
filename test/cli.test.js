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
let nextId = 10;
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
  if (/commentCreate/.test(query)) return { commentCreate: { success: true, comment: { id: 'c1' } } };
  if (/issue\(id/.test(query)) {
    const i = db[v.id];
    if (!i) return { __errors: [{ message: 'Entity not found: Issue' }] };
    return { issue: hydrate(i) };
  }
  return { __errors: [{ message: 'mock: unhandled query' }] };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
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
      env: { PATH: process.env.PATH, HOME: home, LINEAR_API_KEY: 'test-key', LINEAR_API_URL: `http://127.0.0.1:${server.address().port}/graphql` },
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
