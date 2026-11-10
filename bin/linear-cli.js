#!/usr/bin/env node

// Linear CLI. Argument parsing and terminal output live here; the Linear work itself is in
// lib/core.js, which the MCP server (lib/mcp.js) shares.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const core = require('../lib/core');

const {
  getToken, saveToken, fetchIssue, fetchViewer, collectRelations, cycleLabel, rewriteMarkdownAttachments,
  extractIssueCode, resolveIssueCode, looksLikeIssueRef, findExistingIssuePath,
} = core;

function usage(msg) {
  console.error(msg);
  process.exit(1);
}

async function cmdLogin(args) {
  const flag = args[0];
  if (flag === '--env') {
    const tok = getToken();
    if (!tok) usage('No token in env LINEAR_API_KEY/LINEAR_ACCESS_TOKEN.');
    saveToken(tok);
    console.log('Token saved from env.');
    return;
  }
  if (!flag) usage('Usage: linear-cli login <token> | login --env');
  saveToken(flag);
  console.log('Token saved.');
}

async function cmdMe(token) {
  const v = await fetchViewer(token);
  console.log(`${v.name} <${v.email}> (${v.id})`);
}

async function cmdTake(token, argv) {
  let meFlag = false;
  let issueArg = null;
  for (const a of argv || []) {
    if (a === '-me' || a === '--me') meFlag = true;
    else if (!a.startsWith('-') && !issueArg) issueArg = a;
  }
  const issueCode = extractIssueCode(issueArg);
  if (!issueCode) usage('Usage: linear-cli take [-me] <ISSUE_CODE|FULL_URL>');
  const r = await core.takeIssue(token, issueCode, { assignToMe: meFlag });
  console.log(r.alreadyPrepared ? `Already prepared at ${r.folder}` : `Prepared ${r.folder}`);
}

function parseCommentArgs(argv) {
  let issueArg = null;
  let addBody = null;
  const files = [];
  const attach = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' || a === '--message') {
      addBody = argv[i + 1] || '';
      i++;
    } else if (a === '-f' || a === '--files') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) files.push(argv[++i]);
    } else if (a === '-a' || a === '--attach') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) attach.push(argv[++i]);
    } else if (!a.startsWith('-') && !issueArg) {
      issueArg = a;
    }
  }
  return { issueArg, addBody, files, attach };
}

async function cmdComments(token, argv) {
  const { issueArg, addBody, files, attach } = parseCommentArgs(argv);
  const issueCode = resolveIssueCode(issueArg);
  if (!issueCode) usage('Usage: linear-cli comments <ISSUE_CODE|FULL_URL> [-m "comment"] [-f <file.md>] [-a <file>...] (or run inside issue directory)');

  // Comment body: prefer the -f file, fall back to -m. Local file links in the body are
  // resolved against the -f file's folder (or cwd for -m); -a paths against cwd.
  let body = null;
  let baseDir = process.cwd();
  for (const f of files) {
    try {
      if (fs.statSync(f).isFile()) {
        body = fs.readFileSync(f, 'utf8');
        baseDir = path.dirname(path.resolve(f));
        break;
      }
    } catch {}
  }
  if (body == null && addBody) body = addBody;
  if (body == null && attach.length) body = '';

  if (body != null) {
    await core.addComment(token, issueCode, { body, baseDir, attachBaseDir: process.cwd(), attach });
  }

  const { issue, index } = await core.syncIssue(token, issueCode);
  for (const c of issue.comments?.nodes || []) {
    console.log(`[${c.createdAt}] ${c.user?.name || 'Unknown'}:`);
    console.log(rewriteMarkdownAttachments(c.body || '', index));
    console.log('---');
  }
}

async function cmdSync(token, argv) {
  const issueCode = resolveIssueCode(argv && argv.find(a => !a.startsWith('-')));
  if (!issueCode) usage('Usage: linear-cli sync <ISSUE_CODE|FULL_URL> (or run inside issue directory)');
  const { folder } = await core.syncIssue(token, issueCode);
  console.log(`Synced ${folder}`);
}

function hasFzf() {
  const r = spawnSync('fzf', ['-v'], { stdio: 'ignore' });
  return r.status === 0;
}

function cmdList() {
  const items = core.listLocalIssues().map(i => `${i.identifier} — ${i.title}`);
  if (items.length === 0) {
    console.log('No local issues found.');
    return;
  }
  if (hasFzf()) {
    const proc = spawnSync('fzf', { input: items.join('\n'), encoding: 'utf8' });
    process.stdout.write(proc.stdout || '');
  } else {
    console.log(items.join('\n'));
  }
}

// Generic "flags + positionals" parser. `spec` maps flag names to true (takes a value),
// false (boolean) or 'multi' (takes every following value up to the next flag).
function parseArgs(argv, spec) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.prototype.hasOwnProperty.call(spec, a)) {
      if (spec[a] === 'multi') {
        const vals = flags[a] || (flags[a] = []);
        while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) vals.push(argv[++i]);
        if (!vals.length) throw new Error(`Missing value for ${a}`);
      } else if (spec[a]) {
        if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
        flags[a] = argv[++i];
      } else {
        flags[a] = true;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function flag(flags, ...names) {
  for (const n of names) if (flags[n] !== undefined) return flags[n];
  return undefined;
}

function fzfPick(lines) {
  if (!process.stdin.isTTY || !hasFzf()) return null;
  const proc = spawnSync('fzf', ['--no-sort'], { input: lines.join('\n'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
  const out = (proc.stdout || '').trim();
  return out || null;
}

function formatIssueLine(i) {
  const state = i.state?.name ? `[${i.state.name}]` : '';
  return `${i.identifier.padEnd(10)} ${state.padEnd(15)} ${i.title}`;
}

// Prints issue lines; with fzf in an interactive terminal, the picked issue is passed to `take`.
async function listOrPick(token, issues, emptyMsg) {
  if (issues.length === 0) {
    console.log(emptyMsg);
    return;
  }
  const lines = issues.map(formatIssueLine);
  const picked = fzfPick(lines);
  if (picked) {
    const code = extractIssueCode(picked);
    if (code) return cmdTake(token, [code]);
    return;
  }
  console.log(lines.join('\n'));
}

async function cmdMine(token, argv) {
  const { flags } = parseArgs(argv, { '--all': false, '-a': false, '--team': true, '-t': true });
  const issues = await core.listMyIssues(token, { all: !!flag(flags, '--all', '-a'), team: flag(flags, '--team', '-t') });
  await listOrPick(token, issues, 'No issues assigned to you.');
}

async function cmdSearch(token, argv) {
  const { flags, positionals } = parseArgs(argv, { '--team': true, '-t': true, '--all': false, '-a': false });
  const term = positionals.join(' ').trim();
  if (!term) usage('Usage: linear-cli search <text> [--team KEY] [--all]');
  const issues = await core.searchIssues(token, term, { all: !!flag(flags, '--all', '-a'), team: flag(flags, '--team', '-t') });
  await listOrPick(token, issues, `No issues match "${term}".`);
}

async function cmdShow(token, argv) {
  const issueCode = resolveIssueCode(argv.find(a => !a.startsWith('-')));
  if (!issueCode) usage('Usage: linear-cli show <ISSUE_CODE|FULL_URL> (or run inside issue directory)');
  const i = await fetchIssue(token, issueCode);
  const labels = (i.labels?.nodes || []).map(l => l.name);
  const rows = [
    ['State', i.state?.name],
    ['Priority', i.priorityLabel],
    ['Assignee', i.assignee?.name || 'Unassigned'],
    ['Creator', i.creator?.name],
    ['Team', i.team ? `${i.team.name} (${i.team.key})` : null],
    ['Labels', labels.length ? labels.join(', ') : null],
    ['Project', i.project ? `${i.project.name}${i.projectMilestone ? ` / ${i.projectMilestone.name}` : ''}` : null],
    ['Cycle', cycleLabel(i.cycle)],
    ['Parent', i.parent ? `${i.parent.identifier} ${i.parent.title}` : null],
    ['Sub-issues', (i.children?.nodes || []).length ? `${i.children.nodes.length} (${i.children.nodes.map(c => c.identifier).join(', ')})` : null],
    ['Relations', collectRelations(i).map(r => `${r.type} ${r.identifier}`).join(', ') || null],
    ['Updated', i.updatedAt],
    ['URL', i.url],
  ].filter(([, v]) => v);
  console.log(`${i.identifier}: ${i.title}\n`);
  for (const [k, v] of rows) console.log(`${(k + ':').padEnd(12)} ${v}`);
  if (i.description) console.log(`\n${i.description}`);
  if ((i.children?.nodes || []).length || i.parent) console.log('\nRun "linear-cli tree" to see the full hierarchy.');
  const local = findExistingIssuePath(i.identifier);
  if (local) console.log(`\nLocal copy: ${local}`);
}

function openUrl(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  const r = spawnSync(cmd[0], cmd[1], { stdio: 'ignore' });
  return r.status === 0;
}

async function cmdOpen(token, argv) {
  const issueCode = resolveIssueCode(argv.find(a => !a.startsWith('-')));
  if (!issueCode) usage('Usage: linear-cli open <ISSUE_CODE|FULL_URL> (or run inside issue directory)');
  const url = await core.getIssueUrl(token, issueCode);
  console.log(url);
  if (!openUrl(url)) console.error('Could not launch a browser; open the URL above manually.');
}

async function cmdStatus(token, argv) {
  const { positionals } = parseArgs(argv, {});
  // `status STATE` inside an issue dir, or `status ISSUE [STATE...]`
  let issueArg = null;
  let stateWords = positionals;
  if (positionals.length && looksLikeIssueRef(positionals[0])) {
    issueArg = positionals[0];
    stateWords = positionals.slice(1);
  }
  const issueCode = resolveIssueCode(issueArg);
  if (!issueCode) usage('Usage: linear-cli status [ISSUE_CODE] [STATE] (or run inside issue directory)');
  const wanted = stateWords.join(' ').trim();
  if (!wanted) {
    const { issue, states } = await core.listStates(token, issueCode);
    console.log(`${issue.identifier} is ${issue.state.name}\n\nAvailable states:`);
    for (const st of states) console.log(`  ${st.id === issue.state.id ? '*' : ' '} ${st.name} (${st.type})`);
    return;
  }
  const r = await core.setState(token, issueCode, wanted);
  console.log(r.changed ? `${r.identifier}: ${r.from} → ${r.to}` : `${r.identifier} is already ${r.to}`);
}

async function cmdAssign(token, argv) {
  const { flags, positionals } = parseArgs(argv, { '-me': false, '--me': false, '--none': false });
  let issueArg = null;
  let who = positionals;
  if (positionals.length && looksLikeIssueRef(positionals[0])) {
    issueArg = positionals[0];
    who = positionals.slice(1);
  }
  const issueCode = resolveIssueCode(issueArg);
  const me = flag(flags, '-me', '--me');
  const none = flag(flags, '--none');
  const target = who.join(' ').trim();
  if (!issueCode || [me, none, target].filter(Boolean).length !== 1) {
    usage('Usage: linear-cli assign [ISSUE_CODE] (-me | --none | <name|email>) (or run inside issue directory)');
  }
  const r = await core.assignIssue(token, issueCode, { me, none, user: target || null });
  console.log(r.assignee ? `${r.identifier} assigned to ${r.assignee}` : `${r.identifier} unassigned`);
}

async function cmdTeams(token) {
  const teams = await core.listTeams(token);
  if (!teams.length) return console.log('No teams found.');
  for (const t of teams) console.log(`${t.key.padEnd(8)} ${t.name}`);
}

async function cmdCreate(token, argv) {
  const { flags, positionals } = parseArgs(argv, {
    '--team': true, '-t': true,
    '-d': true, '--description': true,
    '-f': true, '--file': true,
    '-me': false, '--me': false,
    '--take': false,
    '-a': 'multi', '--attach': 'multi',
  });
  const title = positionals.join(' ').trim();
  if (!title) usage('Usage: linear-cli create [--team KEY] "Title" [-d "description" | -f file.md] [-a file...] [-me] [--take]');
  const file = flag(flags, '-f', '--file');
  const desc = flag(flags, '-d', '--description');
  let description = null;
  let baseDir = process.cwd();
  if (file) {
    description = fs.readFileSync(file, 'utf8');
    baseDir = path.dirname(path.resolve(file));
  } else if (desc) {
    description = desc;
  }
  const i = await core.createIssue(token, {
    title, team: flag(flags, '--team', '-t'), description, baseDir,
    attach: flag(flags, '-a', '--attach') || [], assignToMe: !!flag(flags, '-me', '--me'),
  });
  console.log(`Created ${i.identifier}: ${i.title}\n${i.url}`);
  if (flag(flags, '--take')) await cmdTake(token, [i.identifier]);
}

async function cmdTree(token, argv) {
  const { flags, positionals } = parseArgs(argv, { '--depth': true, '-d': true });
  const issueCode = resolveIssueCode(positionals[0]);
  if (!issueCode) usage('Usage: linear-cli tree [ISSUE_CODE] [--depth N] (or run inside issue directory)');
  const tree = await core.getIssueTree(token, issueCode, flag(flags, '--depth', '-d') || 2);
  console.log(core.renderTree(tree));
}

const HELP = `Usage: linear-cli <command> [args]

Local workflow:
  login <token> | login --env         Save your Linear API key
  me                                  Show your user info
  take [-me] <ISSUE>                  Pull an issue locally (optionally assign yourself)
  sync [ISSUE]                        Refresh a locally stored issue
  comments [ISSUE] [-m "text"] [-f file.md] [-a file...]
                                      Read or post comments (local files are uploaded)
  list                                Browse local issues (fzf if available)

Find & triage:
  mine [--all] [--team KEY]           Issues assigned to you (pick with fzf to take)
  search <text> [--team KEY] [--all]  Search issues (pick with fzf to take)
  show [ISSUE]                        Print an issue summary
  tree [ISSUE] [--depth N]            Show project, parent chain, sub-issues and relations
  open [ISSUE]                        Open the issue in your browser
  status [ISSUE] [STATE]              Show or change workflow state ("progress" → In Progress)
  assign [ISSUE] (-me | --none | <name|email>)
                                      Change the assignee
  create [--team KEY] "Title" [-d text | -f file.md] [-a file...] [-me] [--take]
                                      Create an issue (local files are uploaded)
  teams                               List teams and their keys

MCP:
  mcp                                 Run as an MCP server over stdio (same features as tools)

ISSUE is a code (TEC-123) or URL; when omitted, it is taken from the current issue directory.
Images and files linked from markdown (![](./shot.png), [log](../app.log)) are uploaded to Linear
and the links rewritten; -a/--attach uploads extra files and appends links to them.`;

const COMMANDS = {
  me: (t) => cmdMe(t),
  take: cmdTake,
  comments: cmdComments,
  sync: cmdSync,
  list: () => cmdList(),
  mine: cmdMine,
  search: cmdSearch,
  show: cmdShow,
  tree: cmdTree,
  open: cmdOpen,
  status: cmdStatus,
  assign: cmdAssign,
  teams: (t) => cmdTeams(t),
  create: cmdCreate,
};

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    process.exit(0);
  }
  try {
    if (cmd === 'login') return await cmdLogin(args);
    if (cmd === 'mcp') return require('../lib/mcp').startStdioServer();
    const run = COMMANDS[cmd];
    if (!run) usage(`Unknown command: ${cmd}\nRun "linear-cli help" for usage.`);
    if (cmd === 'list') return run();
    const token = getToken();
    if (!token) usage('Missing token. Set LINEAR_API_KEY or run: linear-cli login <token>');
    await run(token, args);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractIssueCode, pickMatch: core.pickMatch, parseArgs, parseUploadRefs: core.parseUploadRefs,
  rewriteMarkdownAttachments, buildMetadata: core.buildMetadata, findLocalRefs: core.findLocalRefs,
};
