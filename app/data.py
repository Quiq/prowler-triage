import glob
import os
import threading

import pandas as pd

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DATA_DIR = os.path.join(BASE_DIR, "data")
CACHE_DIR = os.path.join(BASE_DIR, "cache")


def discover_environments():
    """One environment per *.csv file directly under data/, keyed by filename
    stem (e.g. data/prod.csv -> "prod"). Re-scanned on every call so dropping
    a new export in data/ picks it up without a restart."""
    envs = {}
    for path in sorted(glob.glob(os.path.join(DATA_DIR, "*.csv"))):
        stem = os.path.splitext(os.path.basename(path))[0]
        envs[stem] = path
    return envs


class _EnvironmentsView(dict):
    """Behaves like a dict but always reflects the current contents of data/."""

    def _refresh(self):
        current = discover_environments()
        self.clear()
        self.update(current)

    def __contains__(self, key):
        self._refresh()
        return dict.__contains__(self, key)

    def __iter__(self):
        self._refresh()
        return dict.__iter__(self)

    def __len__(self):
        self._refresh()
        return dict.__len__(self)

    def items(self):
        self._refresh()
        return dict.items(self)

    def keys(self):
        self._refresh()
        return dict.keys(self)

    def values(self):
        self._refresh()
        return dict.values(self)

    def __getitem__(self, key):
        self._refresh()
        return dict.__getitem__(self, key)


ENVIRONMENTS = _EnvironmentsView(discover_environments())

DISPLAY_COLUMNS = [
    "FINDING_UID",
    "STATUS",
    "SEVERITY",
    "CHECK_ID",
    "CHECK_TITLE",
    "SERVICE_NAME",
    "SUBSERVICE_NAME",
    "RESOURCE_TYPE",
    "RESOURCE_UID",
    "RESOURCE_NAME",
    "REGION",
    "ACCOUNT_UID",
    "ACCOUNT_NAME",
    "STATUS_EXTENDED",
    "MUTED",
    "TIMESTAMP",
]

_lock = threading.Lock()
_cache = {}


def _cache_path(env):
    return os.path.join(CACHE_DIR, f"{env}.parquet")


def _load_csv(env):
    path = ENVIRONMENTS[env]
    df = pd.read_csv(
        path,
        sep=";",
        dtype=str,
        keep_default_na=False,
        na_values=[],
        engine="c",
        on_bad_lines="warn",
    )
    df["SEVERITY"] = df["SEVERITY"].fillna("").str.lower()
    df["STATUS"] = df["STATUS"].fillna("").str.upper()
    df["MUTED_BOOL"] = df["MUTED"].fillna("").str.lower().isin(["true", "1", "yes"])
    # Some providers (AWS in this data) never populate ACCOUNT_NAME, only the
    # raw ACCOUNT_UID — ACCOUNT_DISPLAY is the safe field for anything shown
    # to a person, falling back to the ID so it's never silently blank.
    df["ACCOUNT_DISPLAY"] = df["ACCOUNT_NAME"].where(df["ACCOUNT_NAME"] != "", df["ACCOUNT_UID"])
    return df


def get_dataframe(env):
    if env not in ENVIRONMENTS:
        raise ValueError(f"unknown environment: {env}")

    with _lock:
        src_mtime = os.path.getmtime(ENVIRONMENTS[env])

        cached = _cache.get(env)
        if cached is not None and cached[1] >= src_mtime:
            return cached[0]

        os.makedirs(CACHE_DIR, exist_ok=True)
        cpath = _cache_path(env)

        if os.path.exists(cpath) and os.path.getmtime(cpath) >= src_mtime:
            df = pd.read_parquet(cpath)
        else:
            df = _load_csv(env)
            try:
                df.to_parquet(cpath, index=False)
            except Exception:
                pass

        _cache[env] = (df, src_mtime)
        return df


def reload_environment(env):
    with _lock:
        _cache.pop(env, None)
        cpath = _cache_path(env)
        if os.path.exists(cpath):
            os.remove(cpath)
    return get_dataframe(env)


def severity_rank(sev):
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "informational": 4}
    return order.get((sev or "").lower(), 5)
