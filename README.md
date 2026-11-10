# linear-cli

Work with Linear issues from your terminal, or from an AI assistant over MCP. Pull issue descriptions and attachments to local folders, assign yourself, manage comments, and browse offline.

The same functions back both front ends: `bin/linear-cli.js` (CLI) and `lib/mcp.js` (MCP server) are thin layers over `lib/core.js`.

## Install

```bash
npm install -g .
# or
npm link
```

Requires Node.js >= 14 and optionally [fzf](https://github.com/junegunn/fzf) for interactive issue browsing.

## Setup

Get a [personal API key](https://linear.app/settings/account/security) from Linear and set it:

```bash
linear-cli login <API_KEY>
# or via environment variable (preferred):
export LINEAR_API_KEY=<API_KEY>
linear-cli login --env
```

## Usage

`ISSUE` is an issue code (`TEC-123`) or a Linear URL. Wherever it's optional, the CLI uses the issue of the folder you're in, so inside `~/linear-issues/.../TEC-123/` you can just run `linear status review`.

### Local workflow

| Command | Description |
|---------|-------------|
| `linear-cli me` | Show your user info |
| `linear-cli take [-me] ISSUE` | Pull an issue locally, optionally assign yourself |
| `linear-cli comments [ISSUE] [-m "text"] [-f file.md] [-a file...]` | Read/post comments on an issue |
| `linear-cli sync [ISSUE]` | Refresh a locally stored issue |
| `linear-cli list` | Browse local issues (uses fzf if available) |

### Find and triage

| Command | Description |
|---------|-------------|
| `linear-cli mine [--all] [--team KEY]` | Your open assigned issues. With fzf, the picked issue is pulled via `take` |
| `linear-cli search <text> [--team KEY] [--all]` | Search issues. With fzf, the picked issue is pulled via `take` |
| `linear-cli show [ISSUE]` | Print state, priority, assignee, labels, project, parent, sub-issues, relations |
| `linear-cli tree [ISSUE] [--depth N]` | Show the project, parent chain, sub-issue tree and relations |
| `linear-cli open [ISSUE]` | Open the issue in your browser |
| `linear-cli status [ISSUE] [STATE]` | List states, or change state (fuzzy: `progress` → In Progress) |
| `linear-cli assign [ISSUE] (-me \| --none \| <name\|email>)` | Change the assignee |
| `linear-cli create [--team KEY] "Title" [-d text \| -f file.md] [-a file...] [-me] [--take]` | Create an issue (`--team` optional with a single team) |
| `linear-cli teams` | List teams and their keys |

Using the `linear` wrapper, `take`, `create --take`, and picking from `mine`/`search` drop you into a shell inside the issue folder.

### Attachments both ways

- **Down:** `take`, `sync` and `comments` download files from the description, the attachments list and every comment (all pages). Comment files go in `attachments/comments/`, and links in `description.md` / `comments.md` are rewritten to the local copies. Files that fail to download are listed as a warning.
- **Up:** when you post markdown with `create` or `comments`, local files it links to are uploaded to Linear and the links are rewritten to the uploaded URLs. Paths are resolved from the `-f` file's folder (or the current folder for `-d`/`-m`). Links inside fenced code blocks, web URLs and missing files are left alone. `-a/--attach` uploads extra files and appends links to them (images are embedded).

```bash
# issue.md contains ![repro](./screens/repro.png) and [logs](../server.log)
linear create --team TEC "Checkout crashes on submit" -f issue.md -a trace.har -me --take
linear comments -m "Fixed, see ![after](./after.png)"
```

Example `tree` output:

```
Project: Checkout v2 / Beta
Cycle:   Cycle 7

TEC-1 Epic: checkout [Todo]
  └ ▶ TEC-2 Payment form [In Progress]
      └── TEC-3 Card validation [Todo]

Relations:
  blocks         TEC-4 Backend API [Todo]
  related to     TEC-3 Card validation [Todo]
```

## MCP server

The package also ships an MCP server (stdio), so Claude Code, Claude Desktop, Cursor and other MCP clients can use the same features as tools. Start it with `linear-mcp` or `linear-cli mcp`. It reads the API key the same way the CLI does (`LINEAR_API_KEY`, or the key saved by `linear-cli login`).

Claude Code:

```bash
claude mcp add linear -e LINEAR_API_KEY=lin_api_... -- linear-mcp
```

Claude Desktop / Cursor (`mcpServers` in the client's config file):

```json
{
  "mcpServers": {
    "linear": {
      "command": "linear-mcp",
      "env": { "LINEAR_API_KEY": "lin_api_..." }
    }
  }
}
```

If `linear-mcp` isn't on the client's PATH, use `"command": "node", "args": ["/path/to/linear-cli/bin/linear-mcp.js"]`.

| Tool | CLI equivalent |
|------|----------------|
| `linear_whoami` | `me` |
| `linear_my_issues` | `mine` |
| `linear_search_issues` | `search` |
| `linear_get_issue` | `show` (plus description and comments) |
| `linear_issue_tree` | `tree` (rendered text and JSON) |
| `linear_list_teams` | `teams` |
| `linear_list_states` / `linear_set_status` | `status` |
| `linear_assign_issue` | `assign` (`me`, `none`, or a name/email) |
| `linear_create_issue` | `create` (local files in the description are uploaded; `take: true` pulls it locally) |
| `linear_add_comment` | `comments -m` (local files are uploaded) |
| `linear_take_issue` / `linear_sync_issue` | `take` / `sync` |
| `linear_list_local_issues` | `list` |

Issue arguments are a code (`TEC-123`) or a Linear URL. Relative file paths in `linear_create_issue` and `linear_add_comment` are resolved against `base_dir` (default: the server's working directory). Errors come back as tool errors with the same messages as the CLI.

## Folder structure

Issues are stored under `~/linear-issues/<YYYY-MM-DD>/<ISSUE_CODE>/`:

```
~/linear-issues/
  └── 2026-02-03/
      └── TEC-123/
          ├── description.md
          ├── comments.md
          ├── metadata.json
          └── attachments/
              ├── index.csv
              ├── screenshot.png
              └── comments/
                  └── diagram.png
```

## Development

```bash
npm test
```

Tests run the CLI and the MCP server against an in-process mock of the Linear GraphQL API (`LINEAR_API_URL` points them at it), so no API key or network is needed.

## License

MIT
