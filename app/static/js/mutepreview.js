// Shared "what would this mute rule actually match?" preview, used by both
// the standalone Mutelist page form and the inline mute form on Unique
// Findings group cards. Renders into a container element given a
// /api/<env>/mutelist/preview (or /api/mutelist/preview, multi-env) response
// (or null while loading).
const PREVIEW_DEFAULT_LIMIT = 25;
const PREVIEW_PAGE_SIZE = 500;

const RESOURCE_TRIM_THRESHOLD = 50;

// A mute rule's Resource pattern(s) match against the full RESOURCE_UID
// (an ARN, usually), never the friendly RESOURCE_NAME — but a table full of
// "arn:aws:iam::932183116014:role/" repeated on every row buries the part
// that actually varies. Past a length threshold, trim everything up to and
// including the last "/" and show "…/<tail>" instead — the leading "…"
// signals this is not the full value (so it shouldn't be copied verbatim
// into a Resource pattern field: a pattern still needs the full ARN or a
// leading "*", e.g. "*BackendLambdaExecutionRole"). The untrimmed value is
// always in the title tooltip and via the row's click-through to the full
// finding detail.
function resourceCell(s) {
  const uid = s.RESOURCE_UID || s.RESOURCE_NAME || "";
  const slash = uid.lastIndexOf("/");
  const trimmed = uid.length > RESOURCE_TRIM_THRESHOLD && slash > -1 ? `…/${uid.slice(slash + 1)}` : uid;
  return `<code title="${escapeHtml(uid)}">${escapeHtml(trimmed)}</code>`;
}

function renderMutePreview(container, data, opts) {
  if (!data) {
    container.innerHTML = `<p class="preview-status">Checking what this would mute…</p>`;
    return;
  }
  if (data.error) {
    container.innerHTML = `<p class="preview-status error">${escapeHtml(data.error)}</p>`;
    return;
  }

  // step 0 = default 25-row preview; step N (N>=1) = N * PREVIEW_PAGE_SIZE,
  // loaded incrementally via repeated "show 500 more" clicks rather than one
  // hard cap, so an arbitrarily large match set stays reachable a page at a
  // time instead of either truncating silently or dumping everything at once.
  const step = (opts && opts.step) || 0;
  const expanded = step > 0;
  const onToggle = opts && opts.onToggle;
  const onRowClick = opts && opts.onRowClick;

  // Samples carry ENV only when previewed across more than one environment
  // (the multi-env endpoint) — show that column so it's clear which
  // environment each matched finding actually came from.
  const showEnv = data.samples.some((s) => s.ENV);

  const rows = data.samples
    .map(
      (s, i) => `
    <tr${onRowClick ? ` class="preview-row-clickable" data-sample-idx="${i}"` : ""}>
      ${showEnv ? `<td>${escapeHtml(s.ENV || "")}</td>` : ""}
      <td><span class="badge badge-${s.STATUS}">${s.STATUS}</span></td>
      <td><span class="pill-sev sev-${s.SEVERITY || ""}">${escapeHtml(s.SEVERITY || "")}</span></td>
      <td>${escapeHtml(s.CHECK_ID || "")}</td>
      <td>${resourceCell(s)}</td>
      <td>${escapeHtml(s.ACCOUNT_NAME || "")}</td>
      <td>${escapeHtml(s.REGION || "")}</td>
    </tr>`
    )
    .join("");

  const shown = data.samples.length;
  const more = data.total_matches - shown;

  const perEnvHtml =
    data.per_environment && Object.keys(data.per_environment).length > 1
      ? `<p class="preview-status">${Object.entries(data.per_environment)
          .map(([env, count]) => `${escapeHtml(env)}: <strong>${count.toLocaleString()}</strong>`)
          .join(" · ")}</p>`
      : "";

  container.innerHTML = `
    <p class="preview-status">
      This will mute <strong>${data.total_matches.toLocaleString()}</strong> finding${data.total_matches === 1 ? "" : "s"}
      ${data.already_muted ? ` (${data.already_muted.toLocaleString()} already muted)` : ""}
      ${data.total_matches === 0 ? " — pattern matches nothing, check for typos" : ""}
    </p>
    ${perEnvHtml}
    ${shown ? `
    <div class="preview-table-wrap${expanded ? " expanded" : ""}">
      <table class="preview-table">
        <thead><tr>${showEnv ? "<th>Environment</th>" : ""}<th>Status</th><th>Severity</th><th>Check</th><th>Resource</th><th>Account</th><th>Region</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${more > 0 ? `<p class="preview-status">…and ${more.toLocaleString()} more — <button type="button" class="link-btn preview-toggle" data-action="more">show ${Math.min(more, PREVIEW_PAGE_SIZE).toLocaleString()} more</button></p>` : ""}
    ${expanded && shown > PREVIEW_DEFAULT_LIMIT ? `<p class="preview-status"><button type="button" class="link-btn preview-toggle" data-action="less">Show fewer</button></p>` : ""}
    ` : ""}
  `;

  if (onToggle) {
    const moreBtn = container.querySelector('[data-action="more"]');
    if (moreBtn) moreBtn.addEventListener("click", () => onToggle(step + 1));
    const lessBtn = container.querySelector('[data-action="less"]');
    if (lessBtn) lessBtn.addEventListener("click", () => onToggle(0));
  }

  if (onRowClick) {
    container.querySelectorAll(".preview-row-clickable").forEach((tr) => {
      tr.addEventListener("click", () => onRowClick(data.samples[Number(tr.dataset.sampleIdx)]));
    });
  }
}

// Wires up debounced live-preview on a form's check_id/account/resources/regions
// inputs (any of which may be absent/readonly), rendering into `container`.
//
// `env` may be a plain string or a function returning the environment to
// preview against right now — used for the single-environment case (posts
// to /api/<env>/mutelist/preview).
//
// `getEnvironments`, if given, is a function returning the draft rule's
// full environment selector ('*' or an array of names) — when present the
// preview instead posts to /api/mutelist/preview (multi-env), which tags
// each sample with its source environment. Pass this whenever the form has
// its own Environment field (the Mutelist page), omit it for a form that's
// inherently scoped to one page's environment (the inline mute form on
// Grouped Findings).
//
// getCheckId may return "" (e.g. a not-yet-filled-in Check ID field); in that
// case the preview is skipped and the container is cleared rather than
// treating "" as a wildcard match against every check.
// Returns a `refresh()` function that re-runs the preview immediately
// (e.g. after programmatically changing form values, such as entering edit
// mode) — call it instead of re-invoking wireMutePreview, which would bind
// duplicate input listeners onto the same form.
function wireMutePreview(env, form, container, getCheckId, getEnvironments, onRowClick) {
  let timer;
  let seq = 0;
  let step = 0;

  async function run() {
    const mySeq = ++seq;
    const checkId = (getCheckId() || "").trim();
    renderMutePreview(container, null);
    const resourcesVal = (form.resources?.value || "*").trim() || "*";
    const regionsVal = (form.regions?.value || "*").trim() || "*";
    const account = (form.account?.value || "*").trim() || "*";
    const limit = step > 0 ? step * PREVIEW_PAGE_SIZE : PREVIEW_DEFAULT_LIMIT;

    let res;
    if (getEnvironments) {
      const environments = getEnvironments();
      if (!checkId || !environments || (Array.isArray(environments) && !environments.length)) {
        container.innerHTML = "";
        return;
      }
      res = await fetch(`/api/mutelist/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check_id: checkId,
          account,
          resources: resourcesVal,
          regions: regionsVal,
          environments,
          limit,
        }),
      });
    } else {
      const resolvedEnv = (typeof env === "function" ? env() : env) || "";
      if (!checkId || !resolvedEnv) {
        container.innerHTML = "";
        return;
      }
      res = await fetch(`/api/${resolvedEnv}/mutelist/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          check_id: checkId,
          account,
          resources: resourcesVal,
          regions: regionsVal,
          limit,
        }),
      });
    }

    const data = await res.json();
    if (!res.ok || data.error) {
      if (mySeq === seq) renderMutePreview(container, { error: data.error || "unknown environment" });
      return;
    }
    if (mySeq === seq) {
      // Single-env mode doesn't tag samples with ENV (only the multi-env
      // endpoint does, since it spans several) — resolve it once here so a
      // row click can always look up its finding regardless of which mode
      // ran, without adding a spurious Environment column to a single-env
      // preview by mutating the sample itself.
      const resolvedEnv = getEnvironments ? null : (typeof env === "function" ? env() : env) || "";
      renderMutePreview(container, data, {
        step,
        onToggle: (next) => {
          step = next;
          run();
        },
        onRowClick: onRowClick && ((sample) => onRowClick({ ...sample, ENV: sample.ENV || resolvedEnv })),
      });
    }
  }

  function schedule() {
    step = 0;
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  }

  ["check_id", "account", "resources", "regions", "environments"].forEach((name) => {
    form[name]?.addEventListener("input", schedule);
  });

  run();
  return run;
}
