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

| Command | Description |
|---------|-------------|
| `linear-cli me` | Show your user info |
| `linear-cli take [-me] ISSUE-CODE` | Pull an issue locally, optionally assign yourself |
| `linear-cli comments ISSUE-CODE [-m "text"] [-f file]` | Read/post comments on an issue |
| `linear-cli sync ISSUE-CODE` | Refresh a locally stored issue |
| `linear-cli list` | Browse local issues (uses fzf if available) |
| `linear-cli take ISSUE-CODE` | Pull and `cd` into the issue directory |

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

## License

MIT
