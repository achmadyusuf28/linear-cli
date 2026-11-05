#!/usr/bin/env node

// Minimal Linear CLI (offline scaffold)
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
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

// LINEAR_API_URL lets tests (or self-hosted proxies) point the CLI at another endpoint.
const API_URL = process.env.LINEAR_API_URL || 'https://api.linear.app/graphql';

function graphqlRequest(token, query, variables = {}) {
  const data = JSON.stringify({ query, variables });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Authorization': authHeader(token),
    'public-file-urls-expire-in': '300',
  };
  const transport = API_URL.startsWith('http://') ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(API_URL, { method: 'POST', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(body || '{}');
        } catch (e) {
          return reject(new Error(`Linear API returned HTTP ${res.statusCode} with a non-JSON body`));
        }
        if (json.errors) {
          const msgs = json.errors.map(e => e.message).filter(Boolean).join('; ');
          return reject(new Error('GraphQL error: ' + (msgs || JSON.stringify(json.errors))));
        }
        if (res.statusCode >= 400) return reject(new Error(`Linear API returned HTTP ${res.statusCode}`));
        resolve(json.data);
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

const ISSUE_FIELDS = `id identifier title description url priority priorityLabel createdAt updatedAt
  state { id name type } team { id key name } labels { nodes { name } }
  assignee { id name } creator { id name }
  parent { id identifier title state { name } }
  children(first: 100) { nodes { id identifier title state { name } } }
  project { id name url state } projectMilestone { name } cycle { number name }
  relations(first: 50) { nodes { type relatedIssue { identifier title state { name } } } }
  inverseRelations(first: 50) { nodes { type issue { identifier title state { name } } } }
  attachments { nodes { id url title subtitle } }
  comments(first: 50) { nodes { id body createdAt user { id name } } pageInfo { hasNextPage endCursor } }`;

async function fetchIssue(token, issueCode) {
  const q = `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;
  const data = await graphqlRequest(token, q, { id: issueCode });
  if (!data || !data.issue) throw new Error(`Issue ${issueCode} not found`);
  const issue = data.issue;
  // Page through the rest of the comments so attachments in later comments are not missed.
  let page = issue.comments?.pageInfo;
  while (page && page.hasNextPage) {
    const more = await graphqlRequest(token,
      `query($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { nodes { id body createdAt user { id name } } pageInfo { hasNextPage endCursor } } } }`,
      { id: issue.id, after: page.endCursor });
    issue.comments.nodes.push(...more.issue.comments.nodes);
    page = more.issue.comments.pageInfo;
  }
  return issue;
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

function briefIssue(i) {
  return { identifier: i.identifier, title: i.title, state: i.state?.name || null };
}

// Linear stores a relation once, on the issue that "owns" it. Outgoing relations are read as-is;
// incoming ones are flipped (blocks → blocked by, duplicate → duplicated by).
const RELATION_LABELS = {
  out: { blocks: 'blocks', duplicate: 'duplicate of', related: 'related to', similar: 'similar to' },
  in: { blocks: 'blocked by', duplicate: 'duplicated by', related: 'related to', similar: 'similar to' },
};

function collectRelations(issue) {
  const rels = [];
  for (const r of issue.relations?.nodes || []) {
    if (r.relatedIssue) rels.push({ type: RELATION_LABELS.out[r.type] || r.type, ...briefIssue(r.relatedIssue) });
  }
  for (const r of issue.inverseRelations?.nodes || []) {
    if (r.issue) rels.push({ type: RELATION_LABELS.in[r.type] || r.type, ...briefIssue(r.issue) });
  }
  return rels;
}

function cycleLabel(c) {
  return c ? (c.name ? `${c.name} (#${c.number})` : `Cycle ${c.number}`) : null;
}

function buildMetadata(issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url || null,
    state: issue.state ? { id: issue.state.id, name: issue.state.name, type: issue.state.type } : null,
    priority: issue.priority ?? null,
    priorityLabel: issue.priorityLabel || null,
    team: issue.team ? { id: issue.team.id, key: issue.team.key, name: issue.team.name } : null,
    labels: (issue.labels?.nodes || []).map(l => l.name),
    creator: issue.creator || null,
    assignee: issue.assignee || null,
    parent: issue.parent ? briefIssue(issue.parent) : null,
    children: (issue.children?.nodes || []).map(briefIssue),
    project: issue.project ? { id: issue.project.id, name: issue.project.name, url: issue.project.url, milestone: issue.projectMilestone?.name || null } : null,
    cycle: issue.cycle ? { number: issue.cycle.number, name: issue.cycle.name || null } : null,
    relations: collectRelations(issue),
    timestamps: { createdAt: issue.createdAt, updatedAt: issue.updatedAt },
    attachments: (issue.attachments?.nodes) || [],
  };
}

function renderComments(issue, index) {
  return (issue.comments?.nodes || [])
    .map(c => `- ${c.user?.name || 'Unknown'} at ${c.createdAt}:\n\n${rewriteMarkdownAttachments(c.body || '', index)}\n`)
    .join('\n');
}

// Writes metadata.json, description.md, comments.md and downloads attachments.
// Shared by take, sync and comments so every command produces the same folder layout.
async function writeIssueFolder(token, issue, folder) {
  ensureDir(folder);
  const metadata = buildMetadata(issue);
  writeFileSafe(path.join(folder, 'metadata.json'), JSON.stringify(metadata, null, 2));

  const attachmentsDir = path.join(folder, 'attachments');
  ensureDir(attachmentsDir);
  const indexPath = path.join(attachmentsDir, 'index.csv');
  const index = loadIndex(indexPath);
  // One download per upload: the same file can be referenced from the description, several
  // comments and the attachments list. First occurrence decides the folder.
  const jobs = new Map();
  const queue = (url, name, subdir) => {
    if (!isLinearUpload(url)) return;
    const key = getUploadsId(url) || url;
    if (!jobs.has(key)) jobs.set(key, { url, name, subdir });
  };
  for (const att of metadata.attachments) queue(att.url, att.title, undefined);
  for (const ref of parseUploadRefs(issue.description || '')) queue(ref.url, ref.name, undefined);
  for (const c of issue.comments?.nodes || []) {
    for (const ref of parseUploadRefs(c.body || '')) queue(ref.url, ref.name, 'comments');
  }
  const failures = [];
  await Promise.all([...jobs.values()].map(j =>
    downloadIfLinearAsset(token, j.url, attachmentsDir, j.name, index, indexPath, j.subdir)
      .catch(e => failures.push(`${j.name || j.url}: ${e.message}`))
  ));
  if (failures.length) {
    console.error(`Warning: ${failures.length} attachment(s) could not be downloaded:\n  ${failures.join('\n  ')}`);
  }

  const header = [
    `Creator: ${issue.creator?.name || 'Unknown'}`,
    `Assignee: ${issue.assignee?.name || 'Unassigned'}`,
    `Identifier: ${issue.identifier}`,
    issue.state ? `State: ${issue.state.name}` : null,
    issue.priorityLabel ? `Priority: ${issue.priorityLabel}` : null,
    metadata.labels.length ? `Labels: ${metadata.labels.join(', ')}` : null,
    metadata.project ? `Project: ${metadata.project.name}${metadata.project.milestone ? ` / ${metadata.project.milestone}` : ''}` : null,
    metadata.cycle ? `Cycle: ${cycleLabel(metadata.cycle)}` : null,
    metadata.parent ? `Parent: ${metadata.parent.identifier} ${metadata.parent.title}` : null,
    metadata.children.length ? `Sub-issues: ${metadata.children.map(c => c.identifier).join(', ')}` : null,
    issue.url ? `URL: ${issue.url}` : null,
  ].filter(Boolean).join('\n');
  const baseMd = `# ${issue.title}\n\n${header}\n\n---\n\n${issue.description || ''}\n`;
  writeFileSafe(path.join(folder, 'description.md'), rewriteMarkdownAttachments(baseMd, index));
  writeFileSafe(path.join(folder, 'comments.md'), renderComments(issue, index) || '');
  return { metadata, index };
}

async function fetchViewer(token) {
  return (await graphqlRequest(token, `query { viewer { id name email } }`)).viewer;
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
  if (meFlag) {
    const viewer = await fetchViewer(token);
    await assignMe(token, issueCode, viewer.id).catch((e) => {
      console.error(`Warning: could not assign ${issueCode} to you: ${e.message}`);
    });
  }
  const issue = await fetchIssue(token, issueCode);
  const folder = path.join(ROOT_DIR, dateStamp(), issue.identifier || issueCode);
  await writeIssueFolder(token, issue, folder);
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

    httpGetFollow(u, { Authorization: authHeader(token) }, 5, (err, res) => {
      if (err) return reject(err);
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('download failed with HTTP ' + res.statusCode));
      }
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
  });
}

// GET that follows redirects. The Authorization header is only sent to uploads.linear.app,
// never to whatever storage host a redirect points at.
function httpGetFollow(u, headers, redirectsLeft, cb) {
  const sendHeaders = u.hostname === 'uploads.linear.app' ? headers : {};
  const req = https.request(u, { method: 'GET', headers: sendHeaders }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      if (redirectsLeft <= 0) return cb(new Error('too many redirects'));
      return httpGetFollow(new URL(res.headers.location, u), headers, redirectsLeft - 1, cb);
    }
    cb(null, res);
  });
  req.on('error', cb);
  req.end();
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

// Linear upload URLs, including signed ones (`?signature=...`) returned because of the
// `public-file-urls-expire-in` header.
const UPLOAD_URL_RE = /https:\/\/uploads\.linear\.app\/[\w\-\/.%~]+(?:\?[^\s)"'<>\]]*[^\s)"'<>\].,;:])?/g;

function isLinearUpload(url) {
  return /^https:\/\/uploads\.linear\.app\//.test(url || '');
}

function cleanUploadUrl(url) {
  return url.replace(/[.,;:]+$/, ''); // trailing sentence punctuation on raw URLs
}

function parseUploadRefs(markdown) {
  if (!markdown) return [];
  const refs = new Map();
  // Markdown links and images: [name](url) / ![name](url)
  const mdRe = /!?\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;
  let m;
  while ((m = mdRe.exec(markdown)) !== null) {
    const url = cleanUploadUrl(m[2]);
    if (!refs.has(url)) refs.set(url, { url, name: m[1] || undefined });
  }
  // Raw URLs
  for (const raw of markdown.match(UPLOAD_URL_RE) || []) {
    const url = cleanUploadUrl(raw);
    if (!refs.has(url)) refs.set(url, { url, name: undefined });
  }
  return [...refs.values()];
}

function loadIndex(indexPath) {
  const map = {};
  try {
    const txt = fs.readFileSync(indexPath, 'utf8');
    const lines = txt.split(/\r?\n/).filter(l => l.trim().length > 0);
    for (const line of lines.slice(1)) { // skip header if present
      const [id, ...rest] = line.split(',');
      const filename = rest.join(',');
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
    // Also swallow a signed-URL query string so local links don't end in `?signature=...`
    const urlPattern = new RegExp(`https://uploads\\.linear\\.app/[\\w\\-/.%~]*${escapeRegExp(id)}(?:\\?[^\\s)"'<>\\]]*[^\\s)"'<>\\].,;:])?`, 'g');
    out = out.replace(urlPattern, `attachments/${filename}`);
  }
  return out;
}

function parseCommentArgs(argv) {
  let issueArg = null;
  let addBody = null;
  let files = [];
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

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', heic: 'image/heic',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', json: 'application/json',
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};

function guessMime(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

function isImageFile(filePath) {
  return guessMime(filePath).startsWith('image/');
}

function putFile(uploadUrl, filePath, contentType, size, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': contentType,
      'Content-Length': size,
      'Cache-Control': 'public, max-age=31536000',
    };
    for (const h of extraHeaders || []) headers[h.key] = h.value;
    const u = new URL(uploadUrl);
    const transport = u.protocol === 'http:' ? http : https;
    const req = transport.request(u, { method: 'PUT', headers }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`upload failed with HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    fs.createReadStream(filePath).on('error', reject).pipe(req);
  });
}

// Uploads a local file to Linear's storage and returns its uploads.linear.app URL.
async function uploadFile(token, filePath) {
  const size = fs.statSync(filePath).size;
  const contentType = guessMime(filePath);
  const filename = path.basename(filePath);
  const m = `mutation($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }`;
  const res = await graphqlRequest(token, m, { contentType, filename, size });
  if (!res.fileUpload?.success) throw new Error(`Linear refused the upload of ${filename}`);
  const { uploadUrl, assetUrl, headers } = res.fileUpload.uploadFile;
  await putFile(uploadUrl, filePath, contentType, size, headers);
  return assetUrl;
}

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

// Finds `![alt](path)` / `[text](path)` references to local files, outside fenced code blocks.
function findLocalRefs(markdown) {
  const refs = [];
  const parts = markdown.split(/(^```[\s\S]*?^```)/m);
  let offset = 0;
  parts.forEach((part, idx) => {
    if (idx % 2 === 0) {
      const re = /(!?)\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(\s+"[^"]*")?\s*\)/g;
      let m;
      while ((m = re.exec(part)) !== null) {
        let target = m[3].replace(/^<|>$/g, '');
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) continue;
        try { target = decodeURIComponent(target); } catch {}
        refs.push({ start: offset + m.index, end: offset + m.index + m[0].length, image: m[1] === '!', text: m[2], target, title: m[4] || '' });
      }
    }
    offset += part.length;
  });
  return refs;
}

// Uploads every local file the markdown links to (resolved against baseDir) and rewrites
// the links to the uploaded URLs. Links to missing files are left as they are, with a warning.
async function uploadLocalRefs(token, markdown, baseDir) {
  if (!markdown) return { markdown, uploaded: [] };
  const refs = findLocalRefs(markdown);
  const byPath = new Map();
  for (const r of refs) {
    const abs = path.resolve(baseDir, expandHome(r.target));
    let ok = false;
    try { ok = fs.statSync(abs).isFile(); } catch {}
    if (!ok) {
      console.error(`Warning: ${r.target} not found; leaving the link as is`);
      continue;
    }
    r.abs = abs;
    if (!byPath.has(abs)) byPath.set(abs, null);
  }
  for (const abs of byPath.keys()) {
    byPath.set(abs, await uploadFile(token, abs));
    console.log(`Uploaded ${path.relative(process.cwd(), abs) || abs}`);
  }
  let out = markdown;
  for (const r of refs.slice().reverse()) {
    if (!r.abs) continue;
    const link = `${r.image ? '!' : ''}[${r.text}](${byPath.get(r.abs)}${r.title})`;
    out = out.slice(0, r.start) + link + out.slice(r.end);
  }
  return { markdown: out, uploaded: [...byPath.keys()] };
}

// Uploads files given with --attach and returns markdown lines to append.
async function uploadAttachments(token, files) {
  const lines = [];
  for (const f of files) {
    const abs = path.resolve(expandHome(f));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`Attachment not found: ${f}`);
    const url = await uploadFile(token, abs);
    const name = path.basename(abs);
    lines.push(isImageFile(abs) ? `![${name}](${url})` : `[${name}](${url})`);
    console.log(`Uploaded ${f}`);
  }
  return lines;
}

// Turns local markdown (+ --attach files) into a body ready to send to Linear.
async function prepareBody(token, body, baseDir, attachFiles) {
  let out = body || '';
  out = (await uploadLocalRefs(token, out, baseDir)).markdown;
  const extra = await uploadAttachments(token, attachFiles || []);
  if (extra.length) out = (out.trim() ? out.replace(/\s*$/, '\n\n') : '') + extra.join('\n') + '\n';
  return out;
}

async function cmdComments(token, argv) {
  const { issueArg, addBody, files, attach } = parseCommentArgs(argv);
  const issueCode = resolveIssueCode(issueArg);
  if (!issueCode) {
    console.error('Usage: linear-cli comments <ISSUE_CODE|FULL_URL> [-m "comment"] [-f <file.md>] [-a <file>...] (or run inside issue directory)');
    process.exit(1);
  }
  const issue = await fetchIssue(token, issueCode);

  // Determine comment body: prefer -f file content, fallback to -m
  // Local file links in the body are resolved against the -f file's folder (or cwd for -m).
  let body = null;
  let baseDir = process.cwd();
  for (const f of files) {
    if (fs.existsSync(f)) {
      try {
        const st = fs.statSync(f);
        if (st.isFile()) {
          body = fs.readFileSync(f, 'utf8');
          baseDir = path.dirname(path.resolve(f));
          break;
        }
      } catch {}
    }
  }
  if (body == null && addBody) body = addBody;
  if (body == null && attach.length) body = '';

  if (body != null) {
    body = await prepareBody(token, body, baseDir, attach);
    const m = `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`;
    await graphqlRequest(token, m, { input: { issueId: issue.id, body } });
  }

  const latest = await fetchIssue(token, issueCode);
  const folder = findExistingIssuePath(issueCode) || path.join(ROOT_DIR, dateStamp(), issueCode);
  const { index } = await writeIssueFolder(token, latest, folder);
  for (const c of latest.comments?.nodes || []) {
    console.log(`[${c.createdAt}] ${c.user?.name || 'Unknown'}:`);
    console.log(rewriteMarkdownAttachments(c.body || '', index));
    console.log('---');
  }
}

async function cmdSync(token, argv) {
  const issueCode = resolveIssueCode(argv && argv.find(a => !a.startsWith('-')));
  if (!issueCode) {
    console.error('Usage: linear-cli sync <ISSUE_CODE|FULL_URL> (or run inside issue directory)');
    process.exit(1);
  }
  const folder = findExistingIssuePath(issueCode) || path.join(ROOT_DIR, dateStamp(), issueCode);
  const issue = await fetchIssue(token, issueCode);
  await writeIssueFolder(token, issue, folder);
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
  // Prefer metadata.json from the issue folder (works from attachments/ etc.),
  // then fall back to a path segment that looks exactly like an issue code.
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
      if (meta.identifier) return meta.identifier;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const segs = process.cwd().split(path.sep).reverse();
  const seg = segs.find(s => /^[A-Z][A-Z0-9]*-\d+$/i.test(s));
  return seg ? seg.toUpperCase() : null;
}

function looksLikeIssueRef(s) {
  return /^[A-Z][A-Z0-9]*-\d+$/i.test(s) || s.includes('linear.app/');
}

function resolveIssueCode(arg) {
  return extractIssueCode(arg) || detectIssueCodeFromCwd();
}

// Generic "flags + positionals" parser. `spec` maps flag names to true (takes a value) or false (boolean).
function parseArgs(argv, spec) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.prototype.hasOwnProperty.call(spec, a)) {
      if (spec[a] === 'multi') {
        // Takes every following value up to the next flag: -a one.png two.pdf
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

// Case-insensitive match: exact, then prefix, then substring. Returns { match } or { candidates }.
function pickMatch(items, query, keysOf) {
  const q = query.trim().toLowerCase();
  const tiers = [
    (k) => k === q,
    (k) => k.startsWith(q),
    (k) => k.includes(q),
  ];
  for (const test of tiers) {
    const hits = items.filter(it => keysOf(it).some(k => k && test(String(k).toLowerCase())));
    if (hits.length === 1) return { match: hits[0] };
    if (hits.length > 1) return { candidates: hits };
  }
  return { candidates: [] };
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

async function findTeam(token, key) {
  const q = `query { teams(first: 100) { nodes { id key name } } }`;
  const teams = (await graphqlRequest(token, q)).teams.nodes;
  if (!key) {
    if (teams.length === 1) return teams[0];
    throw new Error(`Multiple teams found; pass --team <KEY> (one of: ${teams.map(t => t.key).join(', ')})`);
  }
  const t = teams.find(t => t.key.toLowerCase() === key.toLowerCase());
  if (!t) throw new Error(`Team ${key} not found (available: ${teams.map(t => t.key).join(', ')})`);
  return t;
}

async function cmdMine(token, argv) {
  const { flags } = parseArgs(argv, { '--all': false, '-a': false, '--team': true, '-t': true });
  const filter = {};
  if (!flag(flags, '--all', '-a')) filter.state = { type: { nin: ['completed', 'canceled'] } };
  const team = flag(flags, '--team', '-t');
  if (team) filter.team = { key: { eqIgnoreCase: team } };
  const q = `query Mine($filter: IssueFilter) { viewer { assignedIssues(first: 100, filter: $filter, orderBy: updatedAt) { nodes { identifier title priorityLabel state { name type } team { key } } } } }`;
  const data = await graphqlRequest(token, q, { filter });
  await listOrPick(token, data.viewer.assignedIssues.nodes, 'No issues assigned to you.');
}

async function cmdSearch(token, argv) {
  const { flags, positionals } = parseArgs(argv, { '--team': true, '-t': true, '--all': false, '-a': false });
  const term = positionals.join(' ').trim();
  if (!term) {
    console.error('Usage: linear-cli search <text> [--team KEY] [--all]');
    process.exit(1);
  }
  const filter = {};
  const team = flag(flags, '--team', '-t');
  if (team) filter.team = { key: { eqIgnoreCase: team } };
  if (!flag(flags, '--all', '-a')) filter.state = { type: { nin: ['completed', 'canceled'] } };
  const q = `query Search($term: String!, $filter: IssueFilter) { searchIssues(term: $term, first: 50, filter: $filter) { nodes { identifier title state { name type } team { key } } } }`;
  const data = await graphqlRequest(token, q, { term, filter });
  await listOrPick(token, data.searchIssues.nodes, `No issues match "${term}".`);
}

async function cmdShow(token, argv) {
  const issueCode = resolveIssueCode(argv.find(a => !a.startsWith('-')));
  if (!issueCode) {
    console.error('Usage: linear-cli show <ISSUE_CODE|FULL_URL> (or run inside issue directory)');
    process.exit(1);
  }
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
  if (!issueCode) {
    console.error('Usage: linear-cli open <ISSUE_CODE|FULL_URL> (or run inside issue directory)');
    process.exit(1);
  }
  // Use the stored URL when we have a local copy, to skip a network round trip.
  let url = null;
  const local = findExistingIssuePath(issueCode);
  if (local) {
    try { url = JSON.parse(fs.readFileSync(path.join(local, 'metadata.json'), 'utf8')).url || null; } catch {}
  }
  if (!url) {
    const data = await graphqlRequest(token, `query($id: String!) { issue(id: $id) { url } }`, { id: issueCode });
    if (!data.issue) throw new Error(`Issue ${issueCode} not found`);
    url = data.issue.url;
  }
  console.log(url);
  if (!openUrl(url)) console.error('Could not launch a browser; open the URL above manually.');
}

// Refreshes a local copy's metadata.json after a remote change, if one exists.
async function refreshLocalMetadata(token, issueCode) {
  const local = findExistingIssuePath(issueCode);
  if (!local) return;
  const issue = await fetchIssue(token, issueCode);
  await writeIssueFolder(token, issue, local);
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
  if (!issueCode) {
    console.error('Usage: linear-cli status [ISSUE_CODE] [STATE] (or run inside issue directory)');
    process.exit(1);
  }
  const q = `query($id: String!) { issue(id: $id) { id identifier state { id name type } team { states(first: 100) { nodes { id name type position } } } } }`;
  const data = await graphqlRequest(token, q, { id: issueCode });
  const issue = data.issue;
  if (!issue) throw new Error(`Issue ${issueCode} not found`);
  const states = issue.team.states.nodes.slice().sort((a, b) => a.position - b.position);
  const wanted = stateWords.join(' ').trim();
  if (!wanted) {
    console.log(`${issue.identifier} is ${issue.state.name}\n\nAvailable states:`);
    for (const st of states) console.log(`  ${st.id === issue.state.id ? '*' : ' '} ${st.name} (${st.type})`);
    return;
  }
  const { match, candidates } = pickMatch(states, wanted, st => [st.name]);
  if (!match) {
    const names = (candidates.length ? candidates : states).map(st => st.name).join(', ');
    throw new Error(candidates.length ? `"${wanted}" is ambiguous: ${names}` : `No state matches "${wanted}". Available: ${names}`);
  }
  if (match.id === issue.state.id) {
    console.log(`${issue.identifier} is already ${match.name}`);
    return;
  }
  const m = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { state { name } } } }`;
  const res = await graphqlRequest(token, m, { id: issue.id, input: { stateId: match.id } });
  if (!res.issueUpdate.success) throw new Error('Linear rejected the state change');
  console.log(`${issue.identifier}: ${issue.state.name} → ${res.issueUpdate.issue.state.name}`);
  await refreshLocalMetadata(token, issue.identifier);
}

async function findUser(token, query) {
  const filter = { or: [
    { email: { eqIgnoreCase: query } },
    { displayName: { containsIgnoreCase: query } },
    { name: { containsIgnoreCase: query } },
  ] };
  const q = `query($filter: UserFilter) { users(first: 50, filter: $filter) { nodes { id name displayName email active } } }`;
  const users = (await graphqlRequest(token, q, { filter })).users.nodes.filter(u => u.active !== false);
  const { match, candidates } = pickMatch(users, query, u => [u.email, u.displayName, u.name]);
  if (match) return match;
  if (candidates.length) throw new Error(`"${query}" matches several users: ${candidates.map(u => `${u.name} <${u.email}>`).join(', ')}`);
  throw new Error(`No user matches "${query}"`);
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
    console.error('Usage: linear-cli assign [ISSUE_CODE] (-me | --none | <name|email>) (or run inside issue directory)');
    process.exit(1);
  }
  let assignee = null;
  if (me) assignee = await fetchViewer(token);
  else if (target) assignee = await findUser(token, target);
  const m = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier assignee { name } } } }`;
  const res = await graphqlRequest(token, m, { id: issueCode, input: { assigneeId: assignee ? assignee.id : null } });
  if (!res.issueUpdate.success) throw new Error('Linear rejected the assignment');
  const i = res.issueUpdate.issue;
  console.log(i.assignee ? `${i.identifier} assigned to ${i.assignee.name}` : `${i.identifier} unassigned`);
  await refreshLocalMetadata(token, i.identifier);
}

async function cmdTeams(token) {
  const teams = (await graphqlRequest(token, `query { teams(first: 100) { nodes { id key name } } }`)).teams.nodes;
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
  if (!title) {
    console.error('Usage: linear-cli create [--team KEY] "Title" [-d "description" | -f file.md] [-a file...] [-me] [--take]');
    process.exit(1);
  }
  const team = await findTeam(token, flag(flags, '--team', '-t'));
  const input = { teamId: team.id, title };
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
  const attach = flag(flags, '-a', '--attach') || [];
  if (description != null || attach.length) {
    input.description = await prepareBody(token, description || '', baseDir, attach);
  }
  if (flag(flags, '-me', '--me')) input.assigneeId = (await fetchViewer(token)).id;
  const m = `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }`;
  const res = await graphqlRequest(token, m, { input });
  if (!res.issueCreate.success) throw new Error('Linear rejected the new issue');
  const i = res.issueCreate.issue;
  console.log(`Created ${i.identifier}: ${i.title}\n${i.url}`);
  if (flag(flags, '--take')) await cmdTake(token, [i.identifier]);
}

// Builds a nested `children { ... }` selection `depth` levels deep.
function childrenSelection(depth) {
  if (depth <= 0) return '';
  return `children(first: 100) { nodes { identifier title state { name } ${childrenSelection(depth - 1)} } }`;
}

function parentSelection(depth) {
  if (depth <= 0) return '';
  return `parent { identifier title state { name } ${parentSelection(depth - 1)} }`;
}

function stateTag(i) {
  return i.state?.name ? ` [${i.state.name}]` : '';
}

function printChildren(nodes, prefix, out) {
  nodes.forEach((c, idx) => {
    const last = idx === nodes.length - 1;
    out.push(`${prefix}${last ? '└── ' : '├── '}${c.identifier} ${c.title}${stateTag(c)}`);
    const kids = c.children?.nodes || [];
    if (kids.length) printChildren(kids, prefix + (last ? '    ' : '│   '), out);
  });
}

async function cmdTree(token, argv) {
  const { flags, positionals } = parseArgs(argv, { '--depth': true, '-d': true });
  const depth = Math.max(1, Math.min(5, parseInt(flag(flags, '--depth', '-d') || '2', 10) || 2));
  const issueCode = resolveIssueCode(positionals[0]);
  if (!issueCode) {
    console.error('Usage: linear-cli tree [ISSUE_CODE] [--depth N] (or run inside issue directory)');
    process.exit(1);
  }
  const q = `query($id: String!) { issue(id: $id) {
    identifier title state { name }
    project { name url } projectMilestone { name } cycle { number name }
    ${parentSelection(6)}
    ${childrenSelection(depth)}
    relations(first: 50) { nodes { type relatedIssue { identifier title state { name } } } }
    inverseRelations(first: 50) { nodes { type issue { identifier title state { name } } } }
  } }`;
  const data = await graphqlRequest(token, q, { id: issueCode });
  const issue = data.issue;
  if (!issue) throw new Error(`Issue ${issueCode} not found`);

  const out = [];
  if (issue.project) out.push(`Project: ${issue.project.name}${issue.projectMilestone ? ` / ${issue.projectMilestone.name}` : ''}`);
  if (issue.cycle) out.push(`Cycle:   ${cycleLabel(issue.cycle)}`);
  if (out.length) out.push('');

  // Ancestors, root first
  const ancestors = [];
  for (let p = issue.parent; p; p = p.parent) ancestors.unshift(p);
  let indent = '';
  for (const a of ancestors) {
    out.push(`${indent}${a.identifier} ${a.title}${stateTag(a)}`);
    indent += '  ';
  }
  out.push(`${indent}${ancestors.length ? '└ ' : ''}▶ ${issue.identifier} ${issue.title}${stateTag(issue)}`);
  printChildren(issue.children?.nodes || [], indent + (ancestors.length ? '    ' : '  '), out);

  const rels = collectRelations(issue);
  if (rels.length) {
    out.push('', 'Relations:');
    const byType = {};
    for (const r of rels) (byType[r.type] = byType[r.type] || []).push(r);
    for (const [type, list] of Object.entries(byType)) {
      for (const r of list) out.push(`  ${type.padEnd(14)} ${r.identifier} ${r.title}${r.state ? ` [${r.state}]` : ''}`);
    }
  }
  console.log(out.join('\n'));
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
    const run = COMMANDS[cmd];
    if (!run) {
      console.error(`Unknown command: ${cmd}\nRun "linear-cli help" for usage.`);
      process.exit(1);
    }
    if (cmd === 'list') return run();
    const token = getToken();
    if (!token) {
      console.error('Missing token. Set LINEAR_API_KEY or run: linear-cli login <token>');
      process.exit(1);
    }
    await run(token, args);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { extractIssueCode, pickMatch, parseArgs, parseUploadRefs, rewriteMarkdownAttachments, buildMetadata, findLocalRefs };
