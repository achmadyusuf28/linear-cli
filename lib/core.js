// Shared Linear functions used by both the CLI and the MCP server.
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'linear-cli');
const TOKEN_PATH = path.join(CONFIG_DIR, 'token');
const ROOT_DIR = path.join(os.homedir(), 'linear-issues');

// Where progress notes and warnings go. The CLI prints them; the MCP server collects them
// so stdout stays a clean JSON-RPC channel.
const consoleLog = { info: (m) => console.log(m), warn: (m) => console.error(m) };

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
async function writeIssueFolder(token, issue, folder, log = consoleLog) {
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
    log.warn(`Warning: ${failures.length} attachment(s) could not be downloaded:\n  ${failures.join('\n  ')}`);
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
async function uploadLocalRefs(token, markdown, baseDir, log = consoleLog) {
  if (!markdown) return { markdown, uploaded: [] };
  const refs = findLocalRefs(markdown);
  const byPath = new Map();
  for (const r of refs) {
    const abs = path.resolve(baseDir, expandHome(r.target));
    let ok = false;
    try { ok = fs.statSync(abs).isFile(); } catch {}
    if (!ok) {
      log.warn(`Warning: ${r.target} not found; leaving the link as is`);
      continue;
    }
    r.abs = abs;
    if (!byPath.has(abs)) byPath.set(abs, null);
  }
  for (const abs of byPath.keys()) {
    byPath.set(abs, await uploadFile(token, abs));
    log.info(`Uploaded ${path.relative(process.cwd(), abs) || abs}`);
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
async function uploadAttachments(token, files, baseDir = process.cwd(), log = consoleLog) {
  const lines = [];
  for (const f of files) {
    const abs = path.resolve(baseDir, expandHome(f));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`Attachment not found: ${f}`);
    const url = await uploadFile(token, abs);
    const name = path.basename(abs);
    lines.push(isImageFile(abs) ? `![${name}](${url})` : `[${name}](${url})`);
    log.info(`Uploaded ${f}`);
  }
  return lines;
}

// Turns local markdown (+ --attach files) into a body ready to send to Linear.
async function prepareBody(token, body, baseDir, attachFiles, log = consoleLog, attachBaseDir = process.cwd()) {
  let out = body || '';
  out = (await uploadLocalRefs(token, out, baseDir, log)).markdown;
  const extra = await uploadAttachments(token, attachFiles || [], attachBaseDir, log);
  if (extra.length) out = (out.trim() ? out.replace(/\s*$/, '\n\n') : '') + extra.join('\n') + '\n';
  return out;
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

function detectIssueCodeFromCwd(cwd = process.cwd()) {
  // Prefer metadata.json from the issue folder (works from attachments/ etc.),
  // then fall back to a path segment that looks exactly like an issue code.
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
      if (meta.identifier) return meta.identifier;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const segs = cwd.split(path.sep).reverse();
  const seg = segs.find(s => /^[A-Z][A-Z0-9]*-\d+$/i.test(s));
  return seg ? seg.toUpperCase() : null;
}

function looksLikeIssueRef(s) {
  return /^[A-Z][A-Z0-9]*-\d+$/i.test(s) || s.includes('linear.app/');
}

function resolveIssueCode(arg, cwd) {
  return extractIssueCode(arg) || detectIssueCodeFromCwd(cwd);
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
// Builds a nested `children { ... }` selection `depth` levels deep.
function childrenSelection(depth) {
  if (depth <= 0) return '';
  return `children(first: 100) { nodes { identifier title state { name } ${childrenSelection(depth - 1)} } }`;
}

function parentSelection(depth) {
  if (depth <= 0) return '';
  return `parent { identifier title state { name } ${parentSelection(depth - 1)} }`;
}

// ---------------------------------------------------------------------------
// Operations shared by the CLI (bin/linear-cli.js) and the MCP server (lib/mcp.js).
// They return data and never print, except through the `log` they are given.
// ---------------------------------------------------------------------------

const OPEN_STATES = { type: { nin: ['completed', 'canceled'] } };

function issueFolderFor(code) {
  return findExistingIssuePath(code) || path.join(ROOT_DIR, dateStamp(), code);
}

// Pulls an issue into ~/linear-issues/<date>/<CODE>. Does nothing if it is already there.
async function takeIssue(token, issueCode, { assignToMe = false, log = consoleLog } = {}) {
  const existing = findExistingIssuePath(issueCode);
  if (existing) return { folder: existing, alreadyPrepared: true };
  let assignWarning = null;
  if (assignToMe) {
    const viewer = await fetchViewer(token);
    await assignMe(token, issueCode, viewer.id).catch((e) => {
      assignWarning = `Warning: could not assign ${issueCode} to you: ${e.message}`;
      log.warn(assignWarning);
    });
  }
  const issue = await fetchIssue(token, issueCode);
  const folder = path.join(ROOT_DIR, dateStamp(), issue.identifier || issueCode);
  const { metadata } = await writeIssueFolder(token, issue, folder, log);
  return { folder, alreadyPrepared: false, metadata };
}

// Re-downloads an issue into its local folder (creating it if needed).
async function syncIssue(token, issueCode, { log = consoleLog } = {}) {
  const folder = issueFolderFor(issueCode);
  const issue = await fetchIssue(token, issueCode);
  const { metadata, index } = await writeIssueFolder(token, issue, folder, log);
  return { folder, issue, metadata, index };
}

// Refreshes a local copy's metadata.json after a remote change, if one exists.
async function refreshLocalMetadata(token, issueCode, log = consoleLog) {
  const local = findExistingIssuePath(issueCode);
  if (!local) return null;
  const issue = await fetchIssue(token, issueCode);
  await writeIssueFolder(token, issue, local, log);
  return local;
}

// Posts a comment. Local files linked from `body` are uploaded (resolved against baseDir),
// and `attach` files (resolved against attachBaseDir) are uploaded and appended.
async function addComment(token, issueCode, { body = '', baseDir = process.cwd(), attachBaseDir = baseDir, attach = [], log = consoleLog } = {}) {
  const issue = await fetchIssue(token, issueCode);
  const prepared = await prepareBody(token, body, baseDir, attach, log, attachBaseDir);
  if (!prepared.trim()) throw new Error('Comment is empty');
  const m = `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`;
  const res = await graphqlRequest(token, m, { input: { issueId: issue.id, body: prepared } });
  if (!res.commentCreate?.success) throw new Error('Linear rejected the comment');
  return { identifier: issue.identifier, commentId: res.commentCreate.comment?.id || null, body: prepared };
}

function listLocalIssues() {
  const items = [];
  for (const d of safeReaddir(ROOT_DIR)) {
    const dayDir = path.join(ROOT_DIR, d);
    for (const code of safeReaddir(dayDir)) {
      const folder = path.join(dayDir, code);
      let title = '';
      try { title = JSON.parse(fs.readFileSync(path.join(folder, 'metadata.json'), 'utf8')).title || ''; } catch {}
      items.push({ identifier: code, title, date: d, folder });
    }
  }
  return items;
}

async function listMyIssues(token, { all = false, team = null } = {}) {
  const filter = {};
  if (!all) filter.state = OPEN_STATES;
  if (team) filter.team = { key: { eqIgnoreCase: team } };
  const q = `query Mine($filter: IssueFilter) { viewer { assignedIssues(first: 100, filter: $filter, orderBy: updatedAt) { nodes { identifier title priorityLabel state { name type } team { key } } } } }`;
  return (await graphqlRequest(token, q, { filter })).viewer.assignedIssues.nodes;
}

async function searchIssues(token, term, { all = false, team = null } = {}) {
  if (!term || !term.trim()) throw new Error('Search text is required');
  const filter = {};
  if (team) filter.team = { key: { eqIgnoreCase: team } };
  if (!all) filter.state = OPEN_STATES;
  const q = `query Search($term: String!, $filter: IssueFilter) { searchIssues(term: $term, first: 50, filter: $filter) { nodes { identifier title state { name type } team { key } } } }`;
  return (await graphqlRequest(token, q, { term: term.trim(), filter })).searchIssues.nodes;
}

async function listTeams(token) {
  return (await graphqlRequest(token, `query { teams(first: 100) { nodes { id key name } } }`)).teams.nodes;
}

async function getIssueUrl(token, issueCode) {
  const local = findExistingIssuePath(issueCode);
  if (local) {
    try {
      const url = JSON.parse(fs.readFileSync(path.join(local, 'metadata.json'), 'utf8')).url;
      if (url) return url;
    } catch {}
  }
  const data = await graphqlRequest(token, `query($id: String!) { issue(id: $id) { url } }`, { id: issueCode });
  if (!data.issue) throw new Error(`Issue ${issueCode} not found`);
  return data.issue.url;
}

// Returns the issue's current state and its team's workflow states, in board order.
async function listStates(token, issueCode) {
  const q = `query($id: String!) { issue(id: $id) { id identifier state { id name type } team { states(first: 100) { nodes { id name type position } } } } }`;
  const issue = (await graphqlRequest(token, q, { id: issueCode })).issue;
  if (!issue) throw new Error(`Issue ${issueCode} not found`);
  const states = issue.team.states.nodes.slice().sort((a, b) => a.position - b.position);
  return { issue: { id: issue.id, identifier: issue.identifier, state: issue.state }, states };
}

// Moves an issue to the state best matching `wanted` ("progress" → In Progress).
async function setState(token, issueCode, wanted, { log = consoleLog } = {}) {
  const { issue, states } = await listStates(token, issueCode);
  const { match, candidates } = pickMatch(states, wanted, st => [st.name]);
  if (!match) {
    const names = (candidates.length ? candidates : states).map(st => st.name).join(', ');
    throw new Error(candidates.length ? `"${wanted}" is ambiguous: ${names}` : `No state matches "${wanted}". Available: ${names}`);
  }
  if (match.id === issue.state.id) return { identifier: issue.identifier, from: issue.state.name, to: match.name, changed: false };
  const m = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { state { name } } } }`;
  const res = await graphqlRequest(token, m, { id: issue.id, input: { stateId: match.id } });
  if (!res.issueUpdate.success) throw new Error('Linear rejected the state change');
  const localFolder = await refreshLocalMetadata(token, issue.identifier, log);
  return { identifier: issue.identifier, from: issue.state.name, to: res.issueUpdate.issue.state.name, changed: true, localFolder };
}

// who: { me: true } | { none: true } | { user: '<name|email>' }
async function assignIssue(token, issueCode, who, { log = consoleLog } = {}) {
  let assignee = null;
  if (who.me) assignee = await fetchViewer(token);
  else if (who.user) assignee = await findUser(token, who.user);
  else if (!who.none) throw new Error('Say who to assign: me, none, or a name/email');
  const m = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier assignee { name } } } }`;
  const res = await graphqlRequest(token, m, { id: issueCode, input: { assigneeId: assignee ? assignee.id : null } });
  if (!res.issueUpdate.success) throw new Error('Linear rejected the assignment');
  const i = res.issueUpdate.issue;
  const localFolder = await refreshLocalMetadata(token, i.identifier, log);
  return { identifier: i.identifier, assignee: i.assignee ? i.assignee.name : null, localFolder };
}

// Creates an issue. Local files linked from the description are uploaded (resolved against
// baseDir); `attach` files (resolved against attachBaseDir) are uploaded and appended.
async function createIssue(token, { title, team = null, description = null, baseDir = process.cwd(), attachBaseDir = process.cwd(), attach = [], assignToMe = false, log = consoleLog } = {}) {
  if (!title || !title.trim()) throw new Error('Title is required');
  const t = await findTeam(token, team);
  const input = { teamId: t.id, title: title.trim() };
  if (description != null || attach.length) {
    input.description = await prepareBody(token, description || '', baseDir, attach, log, attachBaseDir);
  }
  if (assignToMe) input.assigneeId = (await fetchViewer(token)).id;
  const m = `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }`;
  const res = await graphqlRequest(token, m, { input });
  if (!res.issueCreate.success) throw new Error('Linear rejected the new issue');
  return res.issueCreate.issue;
}

// Fetches the project, parent chain (root first), sub-issue tree and relations of an issue.
async function getIssueTree(token, issueCode, depth = 2) {
  const d = Math.max(1, Math.min(5, parseInt(depth, 10) || 2));
  const q = `query($id: String!) { issue(id: $id) {
    identifier title state { name }
    project { name url } projectMilestone { name } cycle { number name }
    ${parentSelection(6)}
    ${childrenSelection(d)}
    relations(first: 50) { nodes { type relatedIssue { identifier title state { name } } } }
    inverseRelations(first: 50) { nodes { type issue { identifier title state { name } } } }
  } }`;
  const issue = (await graphqlRequest(token, q, { id: issueCode })).issue;
  if (!issue) throw new Error(`Issue ${issueCode} not found`);
  const ancestors = [];
  for (let p = issue.parent; p; p = p.parent) ancestors.unshift(briefIssue(p));
  const toTree = (n) => ({ ...briefIssue(n), children: (n.children?.nodes || []).map(toTree) });
  return {
    project: issue.project ? { name: issue.project.name, url: issue.project.url, milestone: issue.projectMilestone?.name || null } : null,
    cycle: issue.cycle ? { number: issue.cycle.number, name: issue.cycle.name || null } : null,
    ancestors,
    issue: briefIssue(issue),
    children: (issue.children?.nodes || []).map(toTree),
    relations: collectRelations(issue),
  };
}

function stateTag(i) {
  const s = typeof i.state === 'string' ? i.state : i.state?.name;
  return s ? ` [${s}]` : '';
}

function printChildren(nodes, prefix, out) {
  nodes.forEach((c, idx) => {
    const last = idx === nodes.length - 1;
    out.push(`${prefix}${last ? '└── ' : '├── '}${c.identifier} ${c.title}${stateTag(c)}`);
    if (c.children?.length) printChildren(c.children, prefix + (last ? '    ' : '│   '), out);
  });
}

// Text rendering of getIssueTree's result, used by `linear-cli tree` and the MCP tool.
function renderTree(tree) {
  const out = [];
  if (tree.project) out.push(`Project: ${tree.project.name}${tree.project.milestone ? ` / ${tree.project.milestone}` : ''}`);
  if (tree.cycle) out.push(`Cycle:   ${cycleLabel(tree.cycle)}`);
  if (out.length) out.push('');
  let indent = '';
  for (const a of tree.ancestors) {
    out.push(`${indent}${a.identifier} ${a.title}${stateTag(a)}`);
    indent += '  ';
  }
  const anc = tree.ancestors.length > 0;
  out.push(`${indent}${anc ? '└ ' : ''}▶ ${tree.issue.identifier} ${tree.issue.title}${stateTag(tree.issue)}`);
  printChildren(tree.children, indent + (anc ? '    ' : '  '), out);
  if (tree.relations.length) {
    out.push('', 'Relations:');
    const byType = {};
    for (const r of tree.relations) (byType[r.type] = byType[r.type] || []).push(r);
    for (const [type, list] of Object.entries(byType)) {
      for (const r of list) out.push(`  ${type.padEnd(14)} ${r.identifier} ${r.title}${r.state ? ` [${r.state}]` : ''}`);
    }
  }
  return out.join('\n');
}

module.exports = {
  // config
  ROOT_DIR, getToken, saveToken, consoleLog,
  // low level
  graphqlRequest, fetchIssue, fetchViewer, findTeam, findUser, buildMetadata, collectRelations, cycleLabel,
  writeIssueFolder, rewriteMarkdownAttachments, parseUploadRefs, findLocalRefs, prepareBody,
  // issue refs
  extractIssueCode, resolveIssueCode, looksLikeIssueRef, findExistingIssuePath, pickMatch,
  // operations
  takeIssue, syncIssue, addComment, listLocalIssues, listMyIssues, searchIssues, listTeams, getIssueUrl,
  listStates, setState, assignIssue, createIssue, getIssueTree, renderTree, refreshLocalMetadata,
};
