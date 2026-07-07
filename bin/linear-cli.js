#!/usr/bin/env node

// Minimal Linear CLI (offline scaffold)
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'linear-cli');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token');
const ROOT_DIR = path.join(os.homedir(), 'linear-issues');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function getToken() {
  const envToken = process.env.LINEAR_API_KEY || process.env.LINEAR_ACCESS_TOKEN;
  if (envToken) return envToken.trim();
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function saveToken(token) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(TOKEN_PATH, token.trim(), { mode: 0o600 });
}

function authHeader(token) {
  // If token already includes Bearer, pass through; else use raw as per personal API key docs
  if (!token) throw new Error('Missing token');
  if (/^Bearer\s+/i.test(token)) return token;
  return token; // Personal API key uses Authorization: <API_KEY>
}

function graphqlRequest(token, query, variables = {}) {
  const data = JSON.stringify({ query, variables });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': authHeader(token),
    'public-file-urls-expire-in': '300',
  };
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.linear.app/graphql', { method: 'POST', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(body || '{}');
          if (json.errors) return reject(new Error('GraphQL error: ' + JSON.stringify(json.errors)));
          resolve(json.data);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function writeFileSafe(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

async function cmdLogin(args) {
  const flag = args[0];
  if (flag === '--env') {
    const tok = getToken();
    if (!tok) {
      console.error('No token in env LINEAR_API_KEY/LINEAR_ACCESS_TOKEN.');
      process.exit(1);
    }
    saveToken(tok);
    console.log('Token saved from env.');
    return;
  }
  const tok = flag;
  if (!tok) {
    console.error('Usage: linear-cli login <token> | login --env');
    process.exit(1);
  }
  saveToken(tok);
  console.log('Token saved.');
}

async function cmdMe(token) {
  const q = `query Me { viewer { id name email } }`;
  const data = await graphqlRequest(token, q);
  const v = data.viewer;
  console.log(`${v.name} <${v.email}> (${v.id})`);
}

async function fetchIssue(token, issueCode) {
  const q = `query Issue($id: String!) { issue(id: $id) { id identifier title description createdAt updatedAt assignee { id name } creator { id name } attachments { nodes { id url title subtitle } } comments(first: 50) { nodes { id body createdAt user { id name } } pageInfo { hasNextPage endCursor } } } }`;
  const data = await graphqlRequest(token, q, { id: issueCode });
  return data.issue;
}

async function assignMe(token, issueCode, myUserId) {
  const m = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id assignee { id name } } } }`;
  const data = await graphqlRequest(token, m, { id: issueCode, input: { assigneeId: myUserId } });
  return data.issueUpdate;
}

function extractIssueCode(input) {
  if (!input) return null;
  // Try to extract shorthand code like TEC-4770 anywhere in the string
  const m = /[A-Z]+-\d+/i.exec(input);
  if (m) return m[0];
  // Try URL parsing with /issue/<CODE>
  try {
    const u = new URL(input);
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('issue');
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  } catch {}
  return null;
}

async function cmdTake(token, argv) {
  let meFlag = false;
  let issueArg = null;
  for (const a of argv || []) {
    if (a === '-me' || a === '--me') meFlag = true;
    else if (!a.startsWith('-') && !issueArg) issueArg = a;
  }
  const issueCode = extractIssueCode(issueArg);
  if (!issueCode) {
    console.error('Usage: linear-cli take [-me] <ISSUE_CODE|FULL_URL>');
    process.exit(1);
  }
  // If already prepared under a different date, do not create a duplicate
  const existingPath = findExistingIssuePath(issueCode);
  if (existingPath) {
    console.log(`Already prepared at ${existingPath}`);
    return;
  }
  let viewer = null;
  if (meFlag) {
    viewer = (await graphqlRequest(token, `query { viewer { id name } }`)).viewer;
  }
  const issue = await fetchIssue(token, issueCode);
  if (meFlag && viewer) {
    await assignMe(token, issueCode, viewer.id).catch(() => {});
  }

  const folder = path.join(ROOT_DIR, dateStamp(), issueCode);
  ensureDir(folder);

  const assigneeName = (issue.assignee?.name) || (viewer?.name) || 'Unassigned';
  const baseMd = `# ${issue.title}\n\nCreator: ${issue.creator?.name || 'Unknown'}\nAssignee: ${assigneeName}\nIdentifier: ${issue.identifier}\n\n---\n\n${issue.description || ''}\n`;

  const metadata = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    creator: issue.creator,
    assignee: issue.assignee || (viewer ? { id: viewer.id, name: viewer.name } : null),
    timestamps: { createdAt: issue.createdAt, updatedAt: issue.updatedAt },
    attachments: (issue.attachments?.nodes) || [],
  };
  writeFileSafe(path.join(folder, 'metadata.json'), JSON.stringify(metadata, null, 2));

  const attachmentsDir = path.join(folder, 'attachments');
  ensureDir(attachmentsDir);
  const indexPath = path.join(attachmentsDir, 'index.csv');
  const index = loadIndex(indexPath);
  // Download attachments and referenced uploads concurrently
  const attPromises = (metadata.attachments || []).map(att =>
    downloadIfLinearAsset(token, att.url, attachmentsDir, undefined, index, indexPath)
  );
  const refPromises = parseUploadRefs(issue.description || '').map(ref =>
    downloadIfLinearAsset(token, ref.url, attachmentsDir, ref.name, index, indexPath)
  );
  const commentRefPromises = (issue.comments?.nodes || []).flatMap(c =>
    parseUploadRefs(c.body || '').map(ref =>
      downloadIfLinearAsset(token, ref.url, attachmentsDir, ref.name, index, indexPath, 'comments')
    )
  );
  await Promise.all([...attPromises, ...refPromises, ...commentRefPromises].map(p => p.catch(() => {})));

  // Rewrite description links to local attachments and save
  const finalMd = rewriteMarkdownAttachments(baseMd, index);
  writeFileSafe(path.join(folder, 'description.md'), finalMd);

  const commentsMd = (issue.comments?.nodes || []).map(c => `- ${c.user?.name || 'Unknown'} at ${c.createdAt}:\n\n${rewriteMarkdownAttachments(c.body || '', index)}\n`).join('\n');
  writeFileSafe(path.join(folder, 'comments.md'), commentsMd || '');
  console.log(`Prepared ${folder}`);
}

function getUploadsId(urlStr) {
  try {
    const u = new URL(urlStr);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || null;
  } catch {
    return null;
  }
}

function downloadIfLinearAsset(token, urlStr, attachmentsBaseDir, preferredName, index, indexPath, subdir) {
  return new Promise((resolve, reject) => {
    if (!urlStr || !/^https:\/\/uploads\.linear\.app\//.test(urlStr)) return resolve();
    const u = new URL(urlStr);
    const id = getUploadsId(urlStr);
    let baseName = (preferredName && preferredName.trim()) || path.basename(u.pathname);
    let effectiveSubdir = subdir || null;
    let hasPriorMapping = false;

    if (id && index && index[id]) {
      hasPriorMapping = true;
      const mappedRelPath = index[id]; // may be 'comments/image.png' or 'image.png'
      const mappedPath = path.join(attachmentsBaseDir, mappedRelPath);
      if (fs.existsSync(mappedPath)) return resolve();
      baseName = path.basename(mappedRelPath);
      const mappedDir = path.dirname(mappedRelPath);
      effectiveSubdir = mappedDir !== '.' ? mappedDir : null;
    }

    const outDir = effectiveSubdir ? path.join(attachmentsBaseDir, effectiveSubdir) : attachmentsBaseDir;
    ensureDir(outDir);

    const req = https.request(u, { method: 'GET', headers: { Authorization: authHeader(token) } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error('Download failed ' + res.statusCode));
      let name = baseName;
      const cd = res.headers['content-disposition'];
      if (cd && !hasPriorMapping) {
        const m = /filename\*=UTF-8''([^;\n]+)|filename="?([^";\n]+)"?/i.exec(cd);
        const fn = decodeURIComponent(m?.[1] || m?.[2] || '') || '';
        if (fn) name = fn;
      } else {
        const ct = res.headers['content-type'] || '';
        const ext = mimeToExt(ct);
        if (ext && !/\.[A-Za-z0-9]+$/.test(name)) name = name + '.' + ext;
      }
      name = sanitizeFileName(name);
      const filePath = hasPriorMapping ? path.join(outDir, name) : uniqueFilePath(outDir, name);
      const ws = fs.createWriteStream(filePath);
      res.pipe(ws);
      ws.on('finish', () => {
        if (id && index) {
          const relPath = effectiveSubdir ? effectiveSubdir + '/' + path.basename(filePath) : path.basename(filePath);
          index[id] = relPath;
          saveIndex(indexPath, index);
        }
        resolve();
      });
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function mimeToExt(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'text/plain': 'txt',
  };
  return map[mime.toLowerCase()] || '';
}

function sanitizeFileName(name) {
  return name.replace(/[\r\n]/g, '').replace(/[\\/:*?"<>|]/g, '_');
}

function uniqueFilePath(outDir, desiredName) {
  const parsed = path.parse(desiredName);
  const base = parsed.name;
  const ext = parsed.ext || '';
  let i = 0;
  let candidate = desiredName;
  let fp = path.join(outDir, candidate);
  while (fs.existsSync(fp)) {
    i += 1;
    candidate = `${base}_${i}${ext}`;
    fp = path.join(outDir, candidate);
  }
  return fp;
}

function parseUploadRefs(markdown) {
  if (!markdown) return [];
  const refs = [];
  const imgRe = /!\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[\w\-\/]+)\)/g;
  const linkRe = /\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[\w\-\/]+)\)/g;
  let m;
  while ((m = imgRe.exec(markdown)) !== null) {
    refs.push({ url: m[2], name: m[1] || undefined });
  }
  while ((m = linkRe.exec(markdown)) !== null) {
    refs.push({ url: m[2], name: m[1] || undefined });
  }
  // Fallback: raw URLs without markdown
  const rawRe = /(https:\/\/uploads\.linear\.app\/[\w\-\/]+)/g;
  while ((m = rawRe.exec(markdown)) !== null) {
    // Avoid duplicates
    if (!refs.some(r => r.url === m[1])) refs.push({ url: m[1], name: undefined });
  }
  return refs;
}

function loadIndex(indexPath) {
  const map = {};
  try {
    const txt = fs.readFileSync(indexPath, 'utf8');
    const lines = txt.split(/\r?\n/).filter(l => l.trim().length > 0);
    for (const line of lines.slice(1)) { // skip header if present
      const [id, filename] = line.split(',');
      if (id && filename) map[id.trim()] = filename.trim();
    }
  } catch {}
  return map;
}

function saveIndex(indexPath, map) {
  const header = 'id,filename\n';
  const body = Object.entries(map).map(([id, fn]) => `${id},${fn}`).join('\n');
  ensureDir(path.dirname(indexPath));
  fs.writeFileSync(indexPath, header + body);
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteMarkdownAttachments(markdown, index) {
  if (!markdown) return markdown;
  let out = markdown;
  for (const [id, filename] of Object.entries(index || {})) {
    const urlPattern = new RegExp(`https\\:\\/\\/uploads\\.linear\\.app\\/[\\w\\-\\/]*${escapeRegExp(id)}`, 'g');
    out = out.replace(urlPattern, `attachments/${filename}`);
  }
  return out;
}

function parseCommentArgs(argv) {
  let issueArg = null;
  let addBody = null;
  let files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' || a === '--message') {
      addBody = argv[i + 1] || '';
      i++;
    } else if (a === '-f' || a === '--files') {
      files = argv.slice(i + 1).filter(x => !x.startsWith('-'));
      break;
    } else if (!a.startsWith('-') && !issueArg) {
      issueArg = a;
    }
  }
  return { issueArg, addBody, files };
}

function isHttpUrl(s) { return /^https?:\/\//i.test(s || ''); }

function copyLocalAttachment(outDir, filePath) {
  const base = path.basename(filePath);
  const target = uniqueFilePath(outDir, sanitizeFileName(base));
  fs.copyFileSync(filePath, target);
  return path.basename(target);
}

async function createIssueAttachment(token, issueId, url, title) {
  const m = `mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success attachment { id } } }`;
  await graphqlRequest(token, m, { input: { issueId, url, title } }).catch(() => {});
}

async function cmdComments(token, argv) {
  const { issueArg, addBody, files } = parseCommentArgs(argv);
  let issueCode = extractIssueCode(issueArg);
  if (!issueCode) issueCode = detectIssueCodeFromCwd();
  if (!issueCode) {
    console.error('Usage: linear-cli comments <ISSUE_CODE|FULL_URL> [-m "comment"] [-f <file>] (or run inside issue directory)');
    process.exit(1);
  }
  const issue = await fetchIssue(token, issueCode);

  // Determine comment body: prefer -f file content, fallback to -m
  let body = null;
  for (const f of files) {
    if (fs.existsSync(f)) {
      try {
        const st = fs.statSync(f);
        if (st.isFile()) {
          body = fs.readFileSync(f, 'utf8');
          break;
        }
      } catch {}
    }
  }
  if (body == null && addBody) body = addBody;

  if (body != null) {
    const m = `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`;
    await graphqlRequest(token, m, { input: { issueId: issue.id, body } });
  }

  const latest = await fetchIssue(token, issueCode);
  const folder = findExistingIssuePath(issueCode) || path.join(ROOT_DIR, dateStamp(), issueCode);
  ensureDir(folder);
  const attachmentsDir = path.join(folder, 'attachments');
  ensureDir(attachmentsDir);
  const indexPath = path.join(attachmentsDir, 'index.csv');
  const index = loadIndex(indexPath);
  const attPromises2 = (latest.attachments?.nodes || []).map(att =>
    downloadIfLinearAsset(token, att.url, attachmentsDir, undefined, index, indexPath)
  );
  const refPromises2 = (latest.comments?.nodes || []).flatMap(c =>
    parseUploadRefs(c.body || '').map(ref =>
      downloadIfLinearAsset(token, ref.url, attachmentsDir, ref.name, index, indexPath, 'comments')
    )
  );
  await Promise.all([...attPromises2, ...refPromises2].map(p => p.catch(() => {})));
  const commentsMd = (latest.comments?.nodes || []).map(c => `- ${c.user?.name || 'Unknown'} at ${c.createdAt}:\n\n${rewriteMarkdownAttachments(c.body || '', index)}\n`).join('\n');
  writeFileSafe(path.join(folder, 'comments.md'), commentsMd || '');
  const list = (latest.comments?.nodes || []).map(c => ({
    id: c.id,
    user: c.user?.name || 'Unknown',
    createdAt: c.createdAt,
    body: rewriteMarkdownAttachments(c.body || '', index),
  }));
  for (const c of list) {
    console.log(`[${c.createdAt}] ${c.user}:`);
    console.log(c.body);
    console.log('---');
  }
}

async function cmdSync(token, argv) {
  const rawArg = argv && argv[0];
  let issueCode = extractIssueCode(rawArg);
  if (!issueCode) issueCode = detectIssueCodeFromCwd();
  if (!issueCode) {
    console.error('Usage: linear-cli sync <ISSUE_CODE|FULL_URL> (or run inside issue directory)');
    process.exit(1);
  }
  const existingPath = findExistingIssuePath(issueCode);
  const folder = existingPath || path.join(ROOT_DIR, dateStamp(), issueCode);
  ensureDir(folder);
  const issue = await fetchIssue(token, issueCode);
  const baseMd = `# ${issue.title}\n\n${issue.description || ''}\n`;
  writeFileSafe(path.join(folder, 'metadata.json'), JSON.stringify({ id: issue.id, identifier: issue.identifier, title: issue.title, timestamps: { createdAt: issue.createdAt, updatedAt: issue.updatedAt } }, null, 2));
  const attachmentsDir = path.join(folder, 'attachments');
  ensureDir(attachmentsDir);
  const indexPath = path.join(attachmentsDir, 'index.csv');
  const index = loadIndex(indexPath);
  const attPromises3 = (issue.attachments?.nodes || []).map(att =>
    downloadIfLinearAsset(token, att.url, attachmentsDir, undefined, index, indexPath)
  );
  const refPromises3 = parseUploadRefs(issue.description || '').map(ref =>
    downloadIfLinearAsset(token, ref.url, attachmentsDir, ref.name, index, indexPath)
  );
  const commentRefPromises3 = (issue.comments?.nodes || []).flatMap(c =>
    parseUploadRefs(c.body || '').map(ref =>
      downloadIfLinearAsset(token, ref.url, attachmentsDir, ref.name, index, indexPath, 'comments')
    )
  );
  await Promise.all([...attPromises3, ...refPromises3, ...commentRefPromises3].map(p => p.catch(() => {})));
  const finalMd = rewriteMarkdownAttachments(baseMd, index);
  writeFileSafe(path.join(folder, 'description.md'), finalMd);
  const commentsMd = (issue.comments?.nodes || []).map(c => `- ${c.user?.name || 'Unknown'} at ${c.createdAt}:\n\n${rewriteMarkdownAttachments(c.body || '', index)}\n`).join('\n');
  writeFileSafe(path.join(folder, 'comments.md'), commentsMd || '');
  console.log(`Synced ${folder}`);
}

function hasFzf() {
  const r = spawnSync('fzf', ['-v'], { stdio: 'ignore' });
  return r.status === 0;
}

function cmdList() {
  const days = safeReaddir(ROOT_DIR);
  const items = [];
  for (const d of days) {
    const dayDir = path.join(ROOT_DIR, d);
    const issues = safeReaddir(dayDir);
    for (const code of issues) {
      const metaPath = path.join(dayDir, code, 'metadata.json');
      let title = '';
      try { title = JSON.parse(fs.readFileSync(metaPath, 'utf8')).title || ''; } catch {}
      items.push(`${code} — ${title}`);
    }
  }
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

function safeReaddir(p) {
  try { return fs.readdirSync(p).filter(f => !f.startsWith('.')); } catch { return []; }
}

function findExistingIssuePath(code) {
  const days = safeReaddir(ROOT_DIR);
  for (const d of days) {
    const p = path.join(ROOT_DIR, d, code);
    try {
      if (fs.statSync(p).isDirectory()) return p;
    } catch {}
  }
  return null;
}

function detectIssueCodeFromCwd() {
  const cwd = process.cwd();
  const m = /[A-Z]+-\d+/i.exec(cwd);
  return m ? m[0] : null;
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('Commands: login <token>|--env, me, take [-me] <ISSUE_CODE|FULL_URL>, comments <ISSUE_CODE|FULL_URL> [-m "comment"] [-f <file>] (or run inside issue dir), sync <ISSUE_CODE|FULL_URL> (or run inside issue dir), list');
    process.exit(0);
  }
  if (cmd === 'login') return cmdLogin(args);

  const token = getToken();
  if (!token) {
    console.error('Missing token. Set LINEAR_API_KEY or run: linear-cli login <token>');
    process.exit(1);
  }

  try {
    if (cmd === 'me') return cmdMe(token);
    if (cmd === 'take') return cmdTake(token, args);
    if (cmd === 'comments') return cmdComments(token, args);
    if (cmd === 'sync') return cmdSync(token, args);
    if (cmd === 'list') return cmdList();
    console.error('Unknown command:', cmd);
    process.exit(1);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

main();
