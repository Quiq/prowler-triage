# Prowler Triage

A lightweight alternative to the stock Prowler dashboard for browsing your
Prowler scan output.

Drop Prowler CSV exports into `data/` — one `<env>.csv` file per environment
(Prowler's standard CSV export format, semicolon-delimited). Every `*.csv`
directly under `data/` is auto-discovered at request time; the environment
name is the filename stem (`data/prod.csv` → `prod`). No code changes needed
to add, rename, or remove an environment — just add/remove the file and
reload the page. `*.ocsf.json` files are ignored (not currently used).

## Why

The stock Prowler dashboard lists every finding row with no way to see the
*shape* of the problem: the same check failing on 40 resources across 10
accounts shows up as 40 identical-looking rows. This app adds:

- **Grouped findings** — every finding deduplicated by `(PROVIDER,
  CHECK_ID)` across all accounts/resources/regions in an environment, with
  affected-resource/account counts, filtering/search, and an expandable
  resource list with full finding detail. This is the view Prowler's
  dashboard doesn't offer.
- **Mutelist** — a UI over Prowler-compatible `mutelist.yaml` files
  (`mutelists/<env>.yaml`), so accepted-risk / false-positive findings can
  be muted without editing Prowler's own `MUTED` column. A single unified
  page lists every mute rule across every environment and lets you scope a
  new rule to one environment, several, or all of them at once. Applied as
  an overlay: a finding is "effectively muted" if either Prowler's own
  `MUTED` flag or a local mute rule matches.

## Running

```
pip install -r requirements.txt
python run.py
```

Then open http://127.0.0.1:5050.

### With Docker

```
docker build -t prowler-triage .
docker run -p 5050:5050 -v $(pwd)/data:/app/data -v $(pwd)/mutelists:/app/mutelists prowler-triage
```

Then open http://127.0.0.1:5050. The `cache/` directory is rebuilt inside
the container automatically and doesn't need to be mounted.

## How data is loaded

1. On first request for an environment, `data/<env>.csv` is parsed with
   pandas and immediately written out to `cache/<env>.parquet`.
2. Every request after that reads `cache/<env>.parquet` instead (far faster
   than re-parsing a large CSV) — as long as it's newer than the source CSV.
3. If you drop a fresh export in `data/<env>.csv`, its mtime becomes newer
   than the cached Parquet, so the next load re-parses the CSV and refreshes
   the cache automatically. The "Reload data" button on the findings page
   forces this immediately (deletes the cache, re-parses).

So `data/` is the source of truth; `cache/` is a disposable derived cache —
safe to delete at any time, it's rebuilt from `data/` on next load.

## Where the mutelist lives

Mute rules are stored in `mutelists/<env>.yaml`, one file per environment, in
Prowler's native mutelist format (`Accounts` → `Checks` → `Regions` /
`Resources` / `Reason` / `Author` / `Date`). A rule can also be written with
`Environment: "*"` to apply across every environment at once. The `/mutes`
page's add/remove UI reads and writes these files directly on disk — there's
no database. It's applied as an overlay on top of Prowler's own `MUTED`
column rather than replacing it: a finding is "effectively muted" if either
is true.

## Data handling

Everything in `data/` (`*.csv`, `*.ocsf.json`, `*.tgz`), the `cache/*.parquet`
cache, and `mutelists/*.yaml` are gitignored — they contain real
account/resource identifiers and are not meant to be committed.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
