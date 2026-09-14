from flask import Blueprint, jsonify, redirect, render_template, request

from .data import ENVIRONMENTS, get_dataframe, reload_environment
from .findings import (
    apply_effective_mute,
    get_facets,
    get_finding_detail,
    get_unique_findings,
    preview_mute,
    preview_mute_environments,
)
from .mutelist import (
    add_rule,
    all_rules_by_provider,
    list_rules,
    list_rules_matching,
    providers_for_environment,
    remove_rule,
    resolve_environments,
    update_rule,
)

bp = Blueprint("main", __name__)


def _env_or_404(env):
    if env not in ENVIRONMENTS:
        return None
    return env


@bp.route("/")
def index():
    summaries = {}
    for env in ENVIRONMENTS:
        try:
            df = get_dataframe(env)
            df = apply_effective_mute(df, env)
            fail = df[df["STATUS"] == "FAIL"]
            muted = int(fail["EFFECTIVE_MUTED"].sum())
            groups = get_unique_findings(env)
            groups_muted = sum(1 for g in groups if g["unmuted_count"] == 0)
            groups_partial = sum(1 for g in groups if g["unmuted_count"] > 0 and g["muted_count"] > 0)
            summaries[env] = {
                "total": len(df),
                "fail": len(fail),
                "passed": int((df["STATUS"] == "PASS").sum()),
                "critical": int((fail["SEVERITY"] == "critical").sum()),
                "high": int((fail["SEVERITY"] == "high").sum()),
                "muted": muted,
                "active": len(fail) - muted,
                "accounts": int(df["ACCOUNT_UID"].nunique()),
                "providers": providers_for_environment(env),
                "groups": len(groups),
                "groups_muted": groups_muted,
                "groups_partial": groups_partial,
                "groups_unmuted": len(groups) - groups_muted - groups_partial,
            }
        except Exception as e:
            summaries[env] = {"error": str(e)}

    ok_summaries = [s for s in summaries.values() if "error" not in s]
    totals = {
        "environments": len(ok_summaries),
        "total": sum(s["total"] for s in ok_summaries),
        "fail": sum(s["fail"] for s in ok_summaries),
        "passed": sum(s["passed"] for s in ok_summaries),
        "muted": sum(s["muted"] for s in ok_summaries),
        "active": sum(s["active"] for s in ok_summaries),
        "critical": sum(s["critical"] for s in ok_summaries),
        "high": sum(s["high"] for s in ok_summaries),
        "groups": sum(s["groups"] for s in ok_summaries),
        "groups_muted": sum(s["groups_muted"] for s in ok_summaries),
        "groups_partial": sum(s["groups_partial"] for s in ok_summaries),
        "groups_unmuted": sum(s["groups_unmuted"] for s in ok_summaries),
    }

    return render_template("index.html", environments=ENVIRONMENTS, summaries=summaries, totals=totals)


@bp.route("/<env>/findings")
def findings(env):
    # All Findings was folded into Grouped Findings (every finding is
    # reachable there, grouped by check, with the same detail popup) —
    # redirect old links/bookmarks instead of 404ing.
    return redirect(f"/{env}/unique")


@bp.route("/<env>/unique")
def unique(env):
    if not _env_or_404(env):
        return "unknown environment", 404
    return render_template("unique.html", env=env)


@bp.route("/<env>/mutelist")
def mutelist_page(env):
    # The per-environment mutelist page was replaced by the single unified
    # /mutes page (which can target one environment, several, or all at
    # once) — redirect old links/bookmarks instead of 404ing.
    return redirect("/mutes")


@bp.route("/mutes")
def mutes_overview():
    return render_template("mutes_overview.html")


# --- JSON API ---


def _parse_multi(name):
    val = request.args.getlist(name)
    return val if val else None


@bp.route("/api/<env>/facets")
def api_facets(env):
    if not _env_or_404(env):
        return jsonify({"error": "unknown environment"}), 404
    return jsonify(get_facets(env))


@bp.route("/api/<env>/findings/<path:finding_uid>")
def api_finding_detail(env, finding_uid):
    if not _env_or_404(env):
        return jsonify({"error": "unknown environment"}), 404
    finding = get_finding_detail(env, finding_uid)
    if finding is None:
        return jsonify({"error": "finding not found"}), 404
    return jsonify(finding)


@bp.route("/api/<env>/unique")
def api_unique(env):
    if not _env_or_404(env):
        return jsonify({"error": "unknown environment"}), 404

    filters = {
        "status": _parse_multi("status"),
        "severity": _parse_multi("severity"),
        "service": _parse_multi("service"),
        "account": _parse_multi("account"),
        "region": _parse_multi("region"),
        "mute_state": request.args.get("mute_state"),
        "q": request.args.get("q"),
    }
    groups = get_unique_findings(env, filters=filters)
    return jsonify({"total": len(groups), "groups": groups})


@bp.route("/api/<env>/reload", methods=["POST"])
def api_reload(env):
    if not _env_or_404(env):
        return jsonify({"error": "unknown environment"}), 404
    reload_environment(env)
    return jsonify({"ok": True})


@bp.route("/api/<env>/mutelist", methods=["GET"])
def api_mutelist_get(env):
    if not _env_or_404(env):
        return jsonify({"error": "unknown environment"}), 404
    with_counts = request.args.get("with_counts", "true") != "false"
    return jsonify({"rules": list_rules(env, with_counts=with_counts)})


def _split_patterns(value):
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()] or ["*"]
    return value or ["*"]


@bp.route("/api/<env>/mutelist", methods=["POST"])
def api_mutelist_add(env):
    if not _env_or_404(env):
        return jsonify({"error": "unknown environment"}), 404
    body = request.get_json(force=True)
    check_id = (body.get("check_id") or "").strip()
    if not check_id:
        return jsonify({"error": "check_id is required"}), 400

    account = (body.get("account") or "*").strip() or "*"
    resources = _split_patterns(body.get("resources"))
    regions = _split_patterns(body.get("regions"))
    reason = (body.get("reason") or "").strip()
    author = (body.get("author") or "").strip()

    add_rule([env], account, check_id, resources, regions, reason, author)
    return jsonify({"ok": True, "rules": list_rules(env, with_counts=True)})


def _preview_limit(body):
    return min(max(int(body.get("limit") or 25), 1), 50000)


@bp.route("/api/<env>/mutelist/preview", methods=["POST"])
def api_mutelist_preview(env):
    if not _env_or_404(env):
        return jsonify({"error": "unknown environment"}), 404
    body = request.get_json(force=True)
    check_id = (body.get("check_id") or "*").strip() or "*"
    account = (body.get("account") or "*").strip() or "*"
    resources = _split_patterns(body.get("resources"))
    regions = _split_patterns(body.get("regions"))
    limit = _preview_limit(body)

    result = preview_mute(env, account, check_id, resources, regions, limit=limit)
    return jsonify(result)


def _parse_rule_index():
    raw = request.args.get("rule_index")
    return int(raw) if raw is not None else None


@bp.route("/api/<env>/mutelist", methods=["DELETE"])
def api_mutelist_remove(env):
    if not _env_or_404(env):
        return jsonify({"error": "unknown environment"}), 404
    account = request.args.get("account", "*")
    check_id = request.args.get("check_id")
    if not check_id:
        return jsonify({"error": "check_id is required"}), 400
    remove_rule(account, check_id, rule_index=_parse_rule_index())
    return jsonify({"ok": True, "rules": list_rules(env, with_counts=True)})


@bp.route("/api/mutelist", methods=["POST"])
def api_mutelist_add_multi():
    """Add a new mute rule scoped to one, several, or all (*) environments
    at once. A given (account, check_id) can carry several independent
    rules — this always adds another one rather than overwriting; use PUT
    to edit a specific existing rule in place."""
    body = request.get_json(force=True)
    check_id = (body.get("check_id") or "").strip()
    if not check_id:
        return jsonify({"error": "check_id is required"}), 400

    env_selector = body.get("environments")
    if not env_selector:
        return jsonify({"error": "environments is required"}), 400
    environments = resolve_environments(env_selector)
    unknown = [e for e in environments if e not in ENVIRONMENTS]
    if unknown:
        return jsonify({"error": f"unknown environment(s): {', '.join(unknown)}"}), 404

    account = (body.get("account") or "*").strip() or "*"
    resources = _split_patterns(body.get("resources"))
    regions = _split_patterns(body.get("regions"))
    reason = (body.get("reason") or "").strip()
    author = (body.get("author") or "").strip()

    add_rule(env_selector, account, check_id, resources, regions, reason, author)
    return jsonify({"ok": True, "environments": environments, "rules": list_rules_matching(account, check_id)})


@bp.route("/api/mutelist", methods=["PUT"])
def api_mutelist_update_multi():
    """Edit one specific existing rule (identified by account, check_id,
    rule_index) in place, instead of adding a new one alongside it."""
    body = request.get_json(force=True)
    check_id = (body.get("check_id") or "").strip()
    if not check_id:
        return jsonify({"error": "check_id is required"}), 400
    if body.get("rule_index") is None:
        return jsonify({"error": "rule_index is required"}), 400
    rule_index = int(body["rule_index"])

    env_selector = body.get("environments")
    if not env_selector:
        return jsonify({"error": "environments is required"}), 400
    environments = resolve_environments(env_selector)
    unknown = [e for e in environments if e not in ENVIRONMENTS]
    if unknown:
        return jsonify({"error": f"unknown environment(s): {', '.join(unknown)}"}), 404

    account = (body.get("account") or "*").strip() or "*"
    resources = _split_patterns(body.get("resources"))
    regions = _split_patterns(body.get("regions"))
    reason = (body.get("reason") or "").strip()
    author = (body.get("author") or "").strip()

    try:
        update_rule(account, check_id, rule_index, env_selector, resources, regions, reason, author)
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    return jsonify({"ok": True, "environments": environments, "rules": list_rules_matching(account, check_id)})


@bp.route("/api/mutelist", methods=["DELETE"])
def api_mutelist_remove_multi():
    """Remove a mute rule entirely (it's a single rule shared across
    whichever environments it names, not one copy per environment). Pass
    rule_index to remove just one of several rules on the same
    (account, check_id); omit it to remove all of them."""
    account = request.args.get("account", "*")
    check_id = request.args.get("check_id")
    if not check_id:
        return jsonify({"error": "check_id is required"}), 400

    remove_rule(account, check_id, rule_index=_parse_rule_index())
    return jsonify({"ok": True})


@bp.route("/api/mutelist/preview", methods=["POST"])
def api_mutelist_preview_multi():
    """Preview a draft rule across one, several, or all (*) environments at
    once — samples are tagged with their source environment so a
    multi-environment preview shows which environment each match came from."""
    body = request.get_json(force=True)
    check_id = (body.get("check_id") or "*").strip() or "*"
    account = (body.get("account") or "*").strip() or "*"
    resources = _split_patterns(body.get("resources"))
    regions = _split_patterns(body.get("regions"))
    limit = _preview_limit(body)

    env_selector = body.get("environments")
    if not env_selector:
        return jsonify({"error": "environments is required"}), 400
    environments = resolve_environments(env_selector)
    unknown = [e for e in environments if e not in ENVIRONMENTS]
    if unknown:
        return jsonify({"error": f"unknown environment(s): {', '.join(unknown)}"}), 404

    result = preview_mute_environments(environments, account, check_id, resources, regions, limit=limit)
    return jsonify(result)


@bp.route("/api/mutes")
def api_mutes_overview():
    with_counts = request.args.get("with_counts", "true") != "false"
    rules = all_rules_by_provider(with_counts=with_counts)
    return jsonify({"rules": rules})
