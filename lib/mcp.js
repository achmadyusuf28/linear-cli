// MCP server (stdio transport) exposing the same Linear functions as the CLI.
// No dependencies: it speaks newline-delimited JSON-RPC 2.0 as the MCP spec describes.
// stdout carries protocol messages only; anything else goes to stderr.
const path = require('path');
const core = require('./core');
const pkg = require('../package.json');

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const issueProp = { type: 'string', description: 'Issue code (e.g. TEC-123) or Linear issue URL' };
const teamProp = { type: 'string', description: 'Team key (e.g. TEC). Optional when the workspace has one team.' };
const allProp = { type: 'boolean', description: 'Include completed and canceled issues', default: false };
const attachProp = { type: 'array', items: { type: 'string' }, description: 'Paths of local files to upload and link at the end' };
const baseDirProp = { type: 'string', description: 'Folder that relative file paths are resolved against (default: the server\'s working directory)' };

function requireIssue(args) {
  const code = core.extractIssueCode(args.issue);
  if (!code) throw new Error('`issue` must be an issue code like TEC-123 or a Linear issue URL');
  return code;
}

function baseDirOf(args) {
  return args.base_dir ? path.resolve(args.base_dir) : process.cwd();
}

// Each tool: description, JSON schema for its arguments, and a handler (token, args, log) → data.
const TOOLS = {
  linear_whoami: {
    description: 'Show the Linear user the API key belongs to.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    run: (token) => core.fetchViewer(token),
  },
  linear_my_issues: {
    description: 'List issues assigned to me, most recently updated first. Open issues only unless `all` is true.',
    inputSchema: { type: 'object', properties: { all: allProp, team: teamProp } },
    readOnly: true,
    run: (token, a) => core.listMyIssues(token, { all: !!a.all, team: a.team || null }),
  },
  linear_search_issues: {
    description: 'Search issues by text. Open issues only unless `all` is true.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Text to search for' }, team: teamProp, all: allProp }, required: ['query'] },
    readOnly: true,
    run: (token, a) => core.searchIssues(token, a.query, { all: !!a.all, team: a.team || null }),
  },
  linear_get_issue: {
    description: 'Get an issue: state, priority, assignee, labels, project, cycle, parent, sub-issues, relations, description and comments.',
    inputSchema: { type: 'object', properties: { issue: issueProp }, required: ['issue'] },
    readOnly: true,
    run: async (token, a) => {
      const i = await core.fetchIssue(token, requireIssue(a));
      return {
        ...core.buildMetadata(i),
        description: i.description || '',
        comments: (i.comments?.nodes || []).map(c => ({ author: c.user?.name || null, createdAt: c.createdAt, body: c.body || '' })),
        localFolder: core.findExistingIssuePath(i.identifier),
      };
    },
  },
  linear_issue_tree: {
    description: 'Show the hierarchy around an issue: project and cycle, parent chain, sub-issue tree and relations (blocks, blocked by, related, duplicates). Returns a rendered text tree and the same data as JSON.',
    inputSchema: { type: 'object', properties: { issue: issueProp, depth: { type: 'integer', minimum: 1, maximum: 5, default: 2, description: 'Sub-issue levels to include' } }, required: ['issue'] },
    readOnly: true,
    run: async (token, a) => {
      const tree = await core.getIssueTree(token, requireIssue(a), a.depth || 2);
      return { rendered: core.renderTree(tree), ...tree };
    },
  },
  linear_list_teams: {
    description: 'List teams and their keys.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    run: (token) => core.listTeams(token),
  },
  linear_list_states: {
    description: 'List the workflow states an issue can move to, and its current state.',
    inputSchema: { type: 'object', properties: { issue: issueProp }, required: ['issue'] },
    readOnly: true,
    run: async (token, a) => {
      const { issue, states } = await core.listStates(token, requireIssue(a));
      return { identifier: issue.identifier, current: issue.state.name, states: states.map(s => ({ name: s.name, type: s.type })) };
    },
  },
  linear_set_status: {
    description: 'Move an issue to another workflow state. The state is matched loosely ("progress" → In Progress, "done" → Done); an ambiguous match is an error listing the options.',
    inputSchema: { type: 'object', properties: { issue: issueProp, state: { type: 'string', description: 'State name or part of it' } }, required: ['issue', 'state'] },
    run: (token, a, log) => core.setState(token, requireIssue(a), a.state, { log }),
  },
  linear_assign_issue: {
    description: 'Change an issue\'s assignee. `assignee` is "me", "none" (unassign), or a name, display name or email.',
    inputSchema: { type: 'object', properties: { issue: issueProp, assignee: { type: 'string', description: '"me", "none", or a name/email' } }, required: ['issue', 'assignee'] },
    run: (token, a, log) => {
      const who = String(a.assignee || '').trim();
      const target = who.toLowerCase() === 'me' ? { me: true } : who.toLowerCase() === 'none' || !who ? { none: true } : { user: who };
      return core.assignIssue(token, requireIssue(a), target, { log });
    },
  },
  linear_create_issue: {
    description: 'Create an issue. Local files linked from the markdown description (![](./shot.png), [log](app.log)) are uploaded and the links rewritten; `attachments` are uploaded and appended. Set `take` to also pull it into the local issues folder.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        team: teamProp,
        description: { type: 'string', description: 'Markdown description' },
        attachments: attachProp,
        base_dir: baseDirProp,
        assign_to_me: { type: 'boolean', default: false },
        take: { type: 'boolean', default: false, description: 'Also download the new issue to ~/linear-issues' },
      },
      required: ['title'],
    },
    run: async (token, a, log) => {
      const baseDir = baseDirOf(a);
      const i = await core.createIssue(token, {
        title: a.title, team: a.team || null, description: a.description ?? null,
        baseDir, attachBaseDir: baseDir, attach: a.attachments || [], assignToMe: !!a.assign_to_me, log,
      });
      const out = { identifier: i.identifier, title: i.title, url: i.url };
      if (a.take) out.localFolder = (await core.takeIssue(token, i.identifier, { log })).folder;
      return out;
    },
  },
  linear_add_comment: {
    description: 'Post a comment on an issue. Local files linked from the markdown body are uploaded and the links rewritten; `attachments` are uploaded and appended.',
    inputSchema: { type: 'object', properties: { issue: issueProp, body: { type: 'string', description: 'Markdown comment' }, attachments: attachProp, base_dir: baseDirProp }, required: ['issue'] },
    run: async (token, a, log) => {
      const code = requireIssue(a);
      const r = await core.addComment(token, code, { body: a.body || '', baseDir: baseDirOf(a), attach: a.attachments || [], log });
      // Keep a local copy current, like the CLI does.
      const localFolder = await core.refreshLocalMetadata(token, r.identifier, log);
      return { ...r, localFolder };
    },
  },
  linear_take_issue: {
    description: 'Pull an issue into ~/linear-issues/<date>/<CODE>/ (description.md, comments.md, metadata.json, attachments/). Optionally assign it to me. Returns the folder path.',
    inputSchema: { type: 'object', properties: { issue: issueProp, assign_to_me: { type: 'boolean', default: false } }, required: ['issue'] },
    run: (token, a, log) => core.takeIssue(token, requireIssue(a), { assignToMe: !!a.assign_to_me, log }),
  },
  linear_sync_issue: {
    description: 'Refresh the local copy of an issue (description, comments, metadata, attachments). Creates it if missing.',
    inputSchema: { type: 'object', properties: { issue: issueProp }, required: ['issue'] },
    run: async (token, a, log) => {
      const { folder, metadata } = await core.syncIssue(token, requireIssue(a), { log });
      return { folder, identifier: metadata.identifier, title: metadata.title };
    },
  },
  linear_list_local_issues: {
    description: 'List issues already pulled into ~/linear-issues, with their folders.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    needsToken: false,
    run: () => core.listLocalIssues(),
  },
};

function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: !!t.readOnly, openWorldHint: true },
  }));
}

async function callTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  const notes = [];
  const log = { info: (m) => notes.push(m), warn: (m) => notes.push(m) };
  try {
    let token = null;
    if (tool.needsToken !== false) {
      token = core.getToken();
      if (!token) throw new Error('Missing Linear API key. Set LINEAR_API_KEY in the MCP server config, or run: linear-cli login <token>');
    }
    const data = await tool.run(token, args || {}, log);
    const content = [];
    if (data && typeof data.rendered === 'string') content.push({ type: 'text', text: data.rendered });
    content.push({ type: 'text', text: JSON.stringify(data, null, 2) });
    if (notes.length) content.push({ type: 'text', text: notes.join('\n') });
    return { content };
  } catch (e) {
    return { content: [{ type: 'text', text: [`Error: ${e.message}`, ...notes].join('\n') }], isError: true };
  }
}

// Handles one JSON-RPC message; returns the response object, or null for notifications.
async function handleMessage(msg) {
  const isRequest = msg && msg.id !== undefined && msg.id !== null;
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: isRequest ? msg.id : null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, ...
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'linear-cli', version: pkg.version },
        instructions: 'Tools for working with Linear issues: find, read, triage, comment, create, and pull issues to ~/linear-issues. Issue arguments accept a code like TEC-123 or a Linear URL.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolList() });
    case 'tools/call':
      return reply(await callTool(msg.params?.name, msg.params?.arguments));
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function startStdioServer(input = process.stdin, output = process.stdout) {
  // Keep stray console.log calls from corrupting the protocol stream.
  console.log = (...a) => console.error(...a);
  const send = (obj) => output.write(JSON.stringify(obj) + '\n');
  let buf = '';
  let pending = Promise.resolve();
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      // Calls run concurrently; each answers when it is done.
      const p = handleMessage(msg).then((res) => { if (res) send(res); })
        .catch((e) => send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e.message } }));
      pending = pending.then(() => p);
    }
  });
  input.on('end', () => pending.then(() => process.exit(0)));
}

module.exports = { TOOLS, handleMessage, callTool, startStdioServer };
