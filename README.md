# linear-cli

Work with Linear issues from your terminal. Pull issue descriptions and attachments to local folders, assign yourself, manage comments, and browse offline.

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
| `linear-cli comments [ISSUE] [-m "text"] [-f file]` | Read/post comments on an issue |
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
| `linear-cli create [--team KEY] "Title" [-d text \| -f file] [-me] [--take]` | Create an issue (`--team` optional with a single team) |
| `linear-cli teams` | List teams and their keys |

Using the `linear` wrapper, `take`, `create --take`, and picking from `mine`/`search` drop you into a shell inside the issue folder.

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

Tests run the CLI against an in-process mock of the Linear GraphQL API (`LINEAR_API_URL` points the CLI at it), so no API key or network is needed.

## License

MIT
