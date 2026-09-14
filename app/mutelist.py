import datetime
import os
import re
import threading

import yaml

from .data import BASE_DIR

MUTELIST_DIR = os.path.join(BASE_DIR, "mutelists")
MUTELIST_PATH = os.path.join(MUTELIST_DIR, "mutelist.yml")

_lock = threading.Lock()


def _empty():
    return {"Accounts": {}}


def load_mutelist():
    if not os.path.exists(MUTELIST_PATH):
        return _empty()
    with open(MUTELIST_PATH, "r") as f:
        data = yaml.safe_load(f) or {}
    if "Accounts" not in data:
        data = _empty()
    return data


def save_mutelist(data):
    os.makedirs(MUTELIST_DIR, exist_ok=True)
    with open(MUTELIST_PATH, "w") as f:
        yaml.safe_dump(data, f, sort_keys=False, default_flow_style=False)


def _rule_environments(check_body):
    envs = (check_body or {}).get("Environments") or ["*"]
    if envs == ["*"] or envs == "*":
        from .data import ENVIRONMENTS

        return sorted(ENVIRONMENTS.keys())
    return list(envs)


def _check_bodies(check_entry):
    """A check's entry under Checks is normally a single rule dict, but can
    be a list of rule dicts — multiple independent mutes on the same
    (account, check_id), e.g. muting several unrelated resources on
    different dates/reasons/regions without merging them into one rule that
    would lose that per-mute detail. Normalizes either shape to a list."""
    if check_entry is None:
        return []
    if isinstance(check_entry, list):
        return [c or {} for c in check_entry]
    return [check_entry]


def list_all_rules(with_counts=False):
    """Every mute rule in the single mutelist, each tagged with the
    environment(s) it applies to (resolved from its Environments field —
    ["*"] expands to every currently-discovered environment). A given
    (account, check_id) can have more than one independent rule — each gets
    its own row here, distinguished by `rule_index`."""
    data = load_mutelist()
    rules = []
    for account, acct_body in (data.get("Accounts") or {}).items():
        checks = (acct_body or {}).get("Checks") or {}
        for check_id, check_entry in checks.items():
            for idx, body in enumerate(_check_bodies(check_entry)):
                environments = _rule_environments(body)
                rules.append(
                    {
                        "account": account,
                        "check_id": check_id,
                        "rule_index": idx,
                        "environments": environments,
                        "environments_raw": body.get("Environments") or ["*"],
                        "regions": body.get("Regions", ["*"]),
                        "resources": body.get("Resources", ["*"]),
                        "tags": body.get("Tags", ["*"]),
                        "exceptions": body.get("Exceptions", {}),
                        "reason": body.get("Reason", ""),
                        "author": body.get("Author", ""),
                        "date": body.get("Date", ""),
                    }
                )

    if with_counts:
        from .findings import preview_mute_environments

        for rule in rules:
            result = preview_mute_environments(
                rule["environments"], rule["account"], rule["check_id"],
                rule["resources"], rule["regions"],
            )
            rule["match_count"] = result["total_matches"]

    return rules


def list_rules(env, with_counts=False):
    """Every mute rule that applies to a specific environment — used by the
    per-environment findings/mute-matching path."""
    return [r for r in list_all_rules(with_counts=with_counts) if env in r["environments"]]


def list_rules_matching(account, check_id, with_counts=True):
    """The single rule for this (account, check_id), if any — used to hand
    the freshly-saved rule back to the UI after an add/edit."""
    return [
        r for r in list_all_rules(with_counts=with_counts)
        if r["account"] == account and r["check_id"] == check_id
    ]


def providers_for_environment(env):
    """The distinct PROVIDER values seen in this environment's findings
    (usually one, e.g. ["aws"]) — used to label mute rules by provider."""
    from .data import get_dataframe

    try:
        df = get_dataframe(env)
    except Exception:
        return []
    return sorted(p for p in df["PROVIDER"].dropna().unique().tolist() if p)


def all_rules_by_provider(with_counts=False):
    """Every mute rule, tagged with its environment(s) and the provider(s)
    of those environments — a single cross-environment view of what's
    muted where, for display on the Mutelist page."""
    rules = list_all_rules(with_counts=with_counts)
    for rule in rules:
        providers = set()
        for env in rule["environments"]:
            providers.update(providers_for_environment(env))
        rule["providers"] = sorted(providers)
    return rules


def _rule_body(environments_field, resources, regions, reason, author):
    return {
        "Environments": environments_field,
        "Regions": regions or ["*"],
        "Resources": resources or ["*"],
        "Tags": ["*"],
        "Reason": reason or "",
        "Author": author or "",
        "Date": datetime.date.today().isoformat(),
    }


def add_rule(environments, account, check_id, resources, regions, reason, author):
    """Add a new, independent rule for (account, check_id). A given
    (account, check_id) can carry several separate rules at once — e.g.
    muting resource A for one reason and resource B for a different reason
    on a different date — each kept distinct rather than merged into one
    (which would lose whichever regions/reason/date didn't happen to be
    picked). A finding is muted if ANY of that check's rules for the
    matching account match it. Use update_rule to edit one of them in place
    instead of adding another."""
    if environments == "*" or environments == ["*"]:
        environments_field = ["*"]
    else:
        environments_field = sorted(environments)

    with _lock:
        data = load_mutelist()
        data.setdefault("Accounts", {})
        acct_key = account or "*"
        data["Accounts"].setdefault(acct_key, {"Checks": {}})
        data["Accounts"][acct_key].setdefault("Checks", {})
        checks = data["Accounts"][acct_key]["Checks"]

        existing_list = _check_bodies(checks.get(check_id))
        existing_list.append(_rule_body(environments_field, resources, regions, reason, author))
        checks[check_id] = existing_list
        save_mutelist(data)
    return data


def update_rule(account, check_id, rule_index, environments, resources, regions, reason, author):
    """Replace one specific rule (by its rule_index within this
    account+check_id's rule list) in place — used by an explicit Edit,
    where changing regions/resources/reason should apply to that one rule
    rather than adding a new one alongside it."""
    if environments == "*" or environments == ["*"]:
        environments_field = ["*"]
    else:
        environments_field = sorted(environments)

    with _lock:
        data = load_mutelist()
        accts = data.get("Accounts", {})
        acct_key = account or "*"
        checks = (accts.get(acct_key) or {}).get("Checks") or {}
        rule_list = _check_bodies(checks.get(check_id))
        if rule_index < 0 or rule_index >= len(rule_list):
            raise ValueError(f"no rule at index {rule_index} for {acct_key}/{check_id}")
        rule_list[rule_index] = _rule_body(environments_field, resources, regions, reason, author)
        checks[check_id] = rule_list
        save_mutelist(data)
    return data


def remove_rule(account, check_id, rule_index=None):
    """Remove a rule. If rule_index is given, only that one rule (within
    this account+check_id's rule list) is removed — otherwise every rule
    for this (account, check_id) is removed."""
    with _lock:
        data = load_mutelist()
        accts = data.get("Accounts", {})
        acct_key = account or "*"
        checks = (accts.get(acct_key) or {}).get("Checks") or {}
        if check_id not in checks:
            return data

        if rule_index is None:
            del checks[check_id]
        else:
            rule_list = _check_bodies(checks.get(check_id))
            if 0 <= rule_index < len(rule_list):
                del rule_list[rule_index]
            if rule_list:
                checks[check_id] = rule_list
            else:
                del checks[check_id]

        if not checks:
            del accts[acct_key]
        save_mutelist(data)
    return data


def resolve_environments(env_selector):
    """env_selector is '*' (every discovered environment, either as the bare
    string or as a single-item list ["*"]) or a list of specific environment
    names."""
    from .data import ENVIRONMENTS

    if env_selector == "*" or env_selector == ["*"]:
        return sorted(ENVIRONMENTS.keys())
    if isinstance(env_selector, str):
        return [env_selector]
    return list(env_selector)


def _pattern_match(pattern, value):
    """Shell-glob-style matching: `*` means "any sequence of characters"
    wherever it appears; everything else in the pattern is matched
    literally (not regex) — so `www*.example.com` matches any bucket
    starting with "www" and ending with ".example.com", no `.*` needed."""
    if pattern in ("*", None, ""):
        return True
    value = value or ""
    # Build a regex from the pattern: escape everything except literal "*",
    # which becomes ".*". re.escape neutralizes any regex-special characters
    # the user typed (., (, [, etc.) so they're matched as literal text.
    regex = "".join(".*" if part == "*" else re.escape(part) for part in re.split(r"(\*)", pattern))
    return re.fullmatch(regex, value) is not None


def build_matcher(env):
    """Returns a function(row_dict) -> (is_muted, reason) using every mute
    rule whose Environments field includes this environment. A finding is
    muted if it matches ANY rule for its account+check (a check can carry
    several independent rules)."""
    data = load_mutelist()
    accounts = data.get("Accounts") or {}

    def matches(row):
        account_uid = row.get("ACCOUNT_UID", "")
        check_id = row.get("CHECK_ID", "")
        resource_uid = row.get("RESOURCE_UID", "")
        region = row.get("REGION", "")

        for acct_pattern, acct_body in accounts.items():
            if not _pattern_match(acct_pattern, account_uid):
                continue
            checks = (acct_body or {}).get("Checks") or {}
            for check_pattern, check_entry in checks.items():
                if not _pattern_match(check_pattern, check_id):
                    continue
                for body in _check_bodies(check_entry):
                    if env not in _rule_environments(body):
                        continue
                    resources = body.get("Resources") or ["*"]
                    regions = body.get("Regions") or ["*"]
                    if any(_pattern_match(r, resource_uid) for r in resources) and any(
                        _pattern_match(r, region) for r in regions
                    ):
                        return True, body.get("Reason", "")
        return False, ""

    return matches


def build_draft_matcher(account, check_id, resources, regions):
    """Same matching logic as build_matcher, but for a single not-yet-saved
    rule — used to preview what a mute rule would match before confirming."""
    account = account or "*"
    check_id = check_id or "*"
    resources = resources or ["*"]
    regions = regions or ["*"]

    def matches(row):
        if not _pattern_match(account, row.get("ACCOUNT_UID", "")):
            return False
        if not _pattern_match(check_id, row.get("CHECK_ID", "")):
            return False
        if not any(_pattern_match(r, row.get("RESOURCE_UID", "")) for r in resources):
            return False
        if not any(_pattern_match(r, row.get("REGION", "")) for r in regions):
            return False
        return True

    return matches
