import pandas as pd

from .data import get_dataframe, severity_rank
from .mutelist import build_matcher

FAIL_STATUSES = {"FAIL"}

# Primary-status sort order: most actionable first (any failure), then
# needs-review, then fully passing last.
STATUS_SORT_ORDER = {"FAIL": 0, "MANUAL": 1, "PASS": 2}


def _status_rank(status):
    return STATUS_SORT_ORDER.get(status, len(STATUS_SORT_ORDER))


def apply_effective_mute(df, env):
    from .mutelist import list_rules

    env_rules = list_rules(env)
    df = df.copy()

    if not env_rules:
        df["CUSTOM_MUTED"] = False
        df["CUSTOM_MUTE_REASON"] = ""
        df["EFFECTIVE_MUTED"] = df["MUTED_BOOL"]
        return df

    # Only rows matching an account+check pattern pair are candidates; this keeps
    # the per-row regex matcher off the full dataset when the mutelist is small.
    matcher = build_matcher(env)
    check_ids_with_rules = {r["check_id"] for r in env_rules}
    has_wildcard_check = any(r["check_id"] == "*" for r in env_rules)
    if has_wildcard_check:
        candidate_mask = df["CHECK_ID"].notna()
    else:
        candidate_mask = df["CHECK_ID"].isin(check_ids_with_rules)

    custom_muted = pd.Series(False, index=df.index)
    custom_reason = pd.Series("", index=df.index)

    if candidate_mask.any():
        sub = df.loc[candidate_mask]
        results = sub.apply(lambda row: matcher(row.to_dict()), axis=1, result_type="expand")
        custom_muted.loc[candidate_mask] = results[0].values
        custom_reason.loc[candidate_mask] = results[1].values

    df["CUSTOM_MUTED"] = custom_muted
    df["CUSTOM_MUTE_REASON"] = custom_reason
    df["EFFECTIVE_MUTED"] = df["MUTED_BOOL"] | df["CUSTOM_MUTED"]
    return df


def filter_findings(df, filters):
    out = df
    status = filters.get("status")
    if status:
        out = out[out["STATUS"].isin(status)]

    severity = filters.get("severity")
    if severity:
        out = out[out["SEVERITY"].isin(severity)]

    service = filters.get("service")
    if service:
        out = out[out["SERVICE_NAME"].isin(service)]

    account = filters.get("account")
    if account:
        out = out[out["ACCOUNT_UID"].isin(account)]

    region = filters.get("region")
    if region:
        out = out[out["REGION"].isin(region)]

    mute_state = filters.get("mute_state")
    if mute_state == "muted":
        out = out[out["EFFECTIVE_MUTED"]]
    elif mute_state == "unmuted":
        out = out[~out["EFFECTIVE_MUTED"]]

    q = filters.get("q")
    if q:
        q_lower = q.lower()
        mask = (
            out["CHECK_TITLE"].str.lower().str.contains(q_lower, na=False)
            | out["RESOURCE_NAME"].str.lower().str.contains(q_lower, na=False)
            | out["RESOURCE_UID"].str.lower().str.contains(q_lower, na=False)
            | out["CHECK_ID"].str.lower().str.contains(q_lower, na=False)
        )
        out = out[mask]

    return out


def get_facets(env):
    df = get_dataframe(env)
    return {
        "status": sorted(df["STATUS"].dropna().unique().tolist()),
        "severity": sorted(df["SEVERITY"].dropna().unique().tolist(), key=severity_rank),
        "service": sorted(df["SERVICE_NAME"].dropna().unique().tolist()),
        "region": sorted(df["REGION"].dropna().unique().tolist()),
        "account": sorted(
            df[["ACCOUNT_UID", "ACCOUNT_DISPLAY"]]
            .drop_duplicates()
            .apply(lambda r: {"uid": r["ACCOUNT_UID"], "name": r["ACCOUNT_DISPLAY"]}, axis=1)
            .tolist(),
            key=lambda a: a["name"] or a["uid"],
        ),
    }


def get_unique_findings(env, filters=None, only_failed=None):
    """Group by PROVIDER + CHECK_ID: the view Prowler's own dashboard doesn't offer.

    Collapses every instance of a check firing (across accounts/regions/resources)
    into one row per unique check, so you see the *shape* of the problem instead of
    a wall of duplicate rows.

    Status is normally taken from filters["status"] (a list, defaulting to
    FAIL-only when absent). `only_failed` is a legacy override kept for
    backwards compatibility: True forces FAIL-only, False forces all statuses.
    """
    df = get_dataframe(env)
    df = apply_effective_mute(df, env)

    mute_state = None
    status_filter = None
    if filters:
        filters = dict(filters)
        mute_state = filters.pop("mute_state", None)
        status_filter = filters.pop("status", None)
        df = filter_findings(df, filters)

    if only_failed is True:
        df = df[df["STATUS"].isin(FAIL_STATUSES)]
    elif only_failed is False:
        pass
    elif status_filter:
        df = df[df["STATUS"].isin(status_filter)]
    else:
        df = df[df["STATUS"].isin(FAIL_STATUSES)]

    if df.empty:
        return []

    df = df.assign(_sev_rank=df["SEVERITY"].map(severity_rank))

    groups = []
    for (provider, check_id), g in df.groupby(["PROVIDER", "CHECK_ID"], sort=False):
        unmuted = g[~g["EFFECTIVE_MUTED"]]
        status_counts = g["STATUS"].value_counts().to_dict()
        unmuted_count = len(unmuted)
        muted_count = len(g) - unmuted_count
        # Primary status: the most-actionable status present (FAIL beats
        # MANUAL beats PASS) — what "sort by status" means for a group that
        # can contain a mix of statuses.
        primary_status = min(status_counts.keys(), key=_status_rank)
        # Mute bucket mirrors the group card's meter coloring: a group with
        # no failures (all PASS) has nothing to fix, so it's never treated
        # as "unmuted" the way a failing-but-unmuted group is.
        has_fail = status_counts.get("FAIL", 0) > 0
        if not has_fail:
            mute_bucket_rank = 0
        elif unmuted_count == 0:
            mute_bucket_rank = 0  # fully muted
        elif muted_count == 0:
            mute_bucket_rank = 2  # fully unmuted
        else:
            mute_bucket_rank = 1  # partial
        groups.append(
            {
                "provider": provider,
                "check_id": check_id,
                "check_title": g["CHECK_TITLE"].iloc[0],
                "severity": g["SEVERITY"].iloc[0],
                "service_name": g["SERVICE_NAME"].iloc[0],
                "description": g["DESCRIPTION"].iloc[0],
                "risk": g["RISK"].iloc[0],
                "recommendation": g["REMEDIATION_RECOMMENDATION_TEXT"].iloc[0],
                "recommendation_url": g["REMEDIATION_RECOMMENDATION_URL"].iloc[0],
                "total_count": len(g),
                "unmuted_count": unmuted_count,
                "muted_count": muted_count,
                "statuses": sorted(status_counts.keys()),
                "status_counts": status_counts,
                "affected_accounts": sorted(g["ACCOUNT_DISPLAY"].dropna().unique().tolist()),
                "affected_account_count": g["ACCOUNT_UID"].nunique(),
                "affected_regions": sorted(
                    [r for r in g["REGION"].dropna().unique().tolist() if r]
                ),
                "resources": g[
                    [
                        "RESOURCE_UID",
                        "RESOURCE_NAME",
                        "RESOURCE_TYPE",
                        "ACCOUNT_DISPLAY",
                        "ACCOUNT_UID",
                        "REGION",
                        "STATUS",
                        "EFFECTIVE_MUTED",
                        "CUSTOM_MUTE_REASON",
                        "STATUS_EXTENDED",
                        "FINDING_UID",
                        "CATEGORIES",
                        "NOTES",
                        "RELATED_URL",
                        "COMPLIANCE",
                    ]
                ].rename(columns={"ACCOUNT_DISPLAY": "ACCOUNT_NAME"}).to_dict(orient="records"),
                "_sev_rank": int(g["_sev_rank"].iloc[0]),
                "_status_rank": _status_rank(primary_status),
                "_status_count": status_counts[primary_status],
                "_mute_bucket_rank": mute_bucket_rank,
            }
        )

    if mute_state == "unmuted":
        groups = [g for g in groups if g["unmuted_count"] > 0]
    elif mute_state == "muted":
        groups = [g for g in groups if g["unmuted_count"] == 0]

    groups.sort(
        key=lambda x: (
            x["_status_rank"],
            x["_sev_rank"],
            x["_mute_bucket_rank"],
            -x["_status_count"],
            x["check_title"],
        )
    )
    return groups


FINDING_DETAIL_COLUMNS = [
    "FINDING_UID",
    "STATUS",
    "SEVERITY",
    "CHECK_ID",
    "CHECK_TITLE",
    "SERVICE_NAME",
    "SUBSERVICE_NAME",
    "RESOURCE_UID",
    "RESOURCE_NAME",
    "RESOURCE_TYPE",
    "ACCOUNT_DISPLAY",
    "ACCOUNT_UID",
    "REGION",
    "CATEGORIES",
    "STATUS_EXTENDED",
    "DESCRIPTION",
    "RISK",
    "REMEDIATION_RECOMMENDATION_TEXT",
    "REMEDIATION_RECOMMENDATION_URL",
    "NOTES",
    "RELATED_URL",
    "COMPLIANCE",
    "EFFECTIVE_MUTED",
    "CUSTOM_MUTE_REASON",
]


def get_finding_detail(env, finding_uid):
    """A single finding's full record, by FINDING_UID — used to fill in the
    detail popup from a lightweight preview-table row (which only carries a
    few display columns) without duplicating the full finding payload
    across every preview response."""
    df = get_dataframe(env)
    df = apply_effective_mute(df, env)
    match = df[df["FINDING_UID"] == finding_uid]
    if match.empty:
        return None
    cols = [c for c in FINDING_DETAIL_COLUMNS if c in match.columns]
    record = match[cols].head(1).to_dict(orient="records")[0]
    record["ACCOUNT_NAME"] = record.pop("ACCOUNT_DISPLAY", "")
    return record


PREVIEW_SAMPLE_LIMIT = 25


def preview_mute(env, account, check_id, resources, regions, limit=PREVIEW_SAMPLE_LIMIT):
    """Show what a not-yet-saved mute rule would match, against the full
    dataset (not just the currently-loaded group), so a mistake in a
    resource/region pattern is visible before it's saved."""
    from .mutelist import build_draft_matcher

    df = get_dataframe(env)
    matcher = build_draft_matcher(account, check_id, resources, regions)

    check_ids = {check_id} if check_id and check_id != "*" else None
    candidates = df if check_ids is None else df[df["CHECK_ID"].isin(check_ids)]

    if candidates.empty:
        return {"total_matches": 0, "already_muted": 0, "samples": []}

    mask = candidates.apply(lambda row: matcher(row.to_dict()), axis=1)
    matched = candidates[mask]

    already_muted = int(matched["MUTED_BOOL"].sum()) if "MUTED_BOOL" in matched else 0

    samples = matched.head(limit)[
        ["STATUS", "SEVERITY", "CHECK_ID", "RESOURCE_UID", "RESOURCE_NAME", "ACCOUNT_DISPLAY", "REGION", "MUTED_BOOL", "FINDING_UID"]
    ].rename(columns={"ACCOUNT_DISPLAY": "ACCOUNT_NAME", "MUTED_BOOL": "MUTED"}).to_dict(orient="records")

    return {
        "total_matches": int(len(matched)),
        "already_muted": already_muted,
        "samples": samples,
    }


def preview_mute_environments(environments, account, check_id, resources, regions, limit=PREVIEW_SAMPLE_LIMIT):
    """Same as preview_mute, but summed across several environments — used
    both to compute a saved rule's total match_count when it applies to
    more than one environment, and to preview a draft multi-environment
    rule. Each sample is tagged with its source environment (`ENV`) since
    otherwise a multi-env preview table gives no way to tell which
    environment a matched finding actually came from."""
    from .data import ENVIRONMENTS

    total_matches = 0
    already_muted = 0
    samples = []
    per_environment = {}
    for env in environments:
        if env not in ENVIRONMENTS:
            # A rule can name an environment whose CSV was since removed or
            # renamed — skip it rather than letting the whole preview 500.
            continue
        result = preview_mute(env, account, check_id, resources, regions, limit=limit)
        total_matches += result["total_matches"]
        already_muted += result["already_muted"]
        per_environment[env] = result["total_matches"]
        if len(samples) < limit:
            remaining = limit - len(samples)
            for sample in result["samples"][:remaining]:
                sample = dict(sample)
                sample["ENV"] = env
                samples.append(sample)

    return {
        "total_matches": total_matches,
        "already_muted": already_muted,
        "samples": samples,
        "per_environment": per_environment,
    }
