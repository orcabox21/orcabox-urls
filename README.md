# orcabox-urls

Live domain manifest for OrcaBox providers.

`urls.json` is checked once a day by [.github/workflows/update-urls.yml](.github/workflows/update-urls.yml).
Every entry is requested with redirects followed; when a provider has moved, its
`url` is rewritten to the new origin and `version` is bumped, and the workflow
commits the change back to `main`.

## Format

```json
[
  {
    "url": "https://new5.hdhub4u.cl",
    "status": 1,
    "version": 2,
    "name": "HDHUB4u",
    "internalName": "HDHUB4u"
  }
]
```

| field          | meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `url`          | current live origin, no trailing slash                          |
| `status`       | `1` reachable at last check, `0` dead                           |
| `version`      | incremented every time `url` changes — clients use it to bust caches |
| `name`         | display name                                                    |
| `internalName` | stable key the app looks up (never rename it)                   |

## Raw endpoint

```
https://raw.githubusercontent.com/orcabox21/orcabox-urls/main/urls.json
```

## Running locally

```bash
node scripts/check-urls.mjs --dry-run
```

Requires Node 20+ (uses built-in `fetch`). No dependencies.

## Check rules

- `2xx`/`3xx` → alive. If the final host differs from the stored one, the entry
  moved: `url` is updated and `version` bumped.
- `401/403/405/406/429/503/52x` → inconclusive (Cloudflare blocking the CI IP);
  the entry is left untouched so the manifest never flaps on a bot check.
- DNS failure, timeout, `404`, `5xx`, or a redirect landing on a parked/suspended
  page → `status` set to `0`. The `url` is kept so a manual fix is one edit.
