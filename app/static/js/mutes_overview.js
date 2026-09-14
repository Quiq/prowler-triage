(function () {
  const form = document.getElementById("add-rule-form");
  const groupsEl = document.getElementById("groups");
  const previewEl = document.getElementById("mute-preview");
  const addRulePanel = document.getElementById("add-rule-panel");
  const addRuleBtn = document.getElementById("add-rule-btn");
  const cancelAddBtn = document.getElementById("cancel-add-btn");
  const qEl = document.getElementById("q");

  const ms = {};
  let allRules = [];
  let debounceTimer;

  const SORTABLE_COLUMNS = {
    check_id: (r) => r.check_id || "",
    match_count: (r) => r.match_count ?? -1,
    reason: (r) => (r.reason || "").toLowerCase(),
    author: (r) => (r.author || "").toLowerCase(),
    date: (r) => r.date || "",
  };
  let sortKey = "date";
  let sortDir = "desc";

  const detailEls = {
    detail: document.getElementById("detail"),
    detailBody: document.getElementById("detail-body"),
    detailClose: document.getElementById("detail-close"),
    detailBackdrop: document.getElementById("detail-backdrop"),
  };
  const findingDetail = wireFindingDetail(detailEls);

  async function showFindingFromSample(sample) {
    findingDetail.showLoading();
    const res = await fetch(`/api/${sample.ENV}/findings/${encodeURIComponent(sample.FINDING_UID)}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      findingDetail.show({ ...sample, STATUS_EXTENDED: data.error || "Could not load this finding's detail." });
      return;
    }
    findingDetail.show(data);
  }

  // Inline SVG instead of emoji glyphs (✏/🗑) — emoji rendering is
  // inconsistent across platforms/fonts and doesn't take currentColor, so
  // it can't be styled to match the button's text color in either theme.
  const ICON_EDIT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="M15 5l4 4"/></svg>`;
  const ICON_REMOVE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;

  function ruleKey(r) {
    return `${r.account}::${r.check_id}::${r.rule_index}`;
  }

  // Total count of known environments, used to recognize a rule whose
  // explicit environment list happens to cover every one of them (not just
  // rules literally stored as "*") — both should read as "All (N)" rather
  // than one saying "All" and the other "N environments" for the same set.
  let knownEnvCount = 0;

  function envLabel(r) {
    const count = (r.environments || []).length;
    const isAll = count > 1 && count >= knownEnvCount;
    if (isAll) {
      return `<span title="${escapeHtml((r.environments || []).join(", "))}">All (${count})</span>`;
    }
    if (count > 1) {
      return `<span title="${escapeHtml(r.environments.join(", "))}">${count} environments</span>`;
    }
    const env = (r.environments && r.environments[0]) || r.source;
    return `<a href="/${escapeHtml(env)}/findings" onclick="event.stopPropagation()">${escapeHtml(env)}</a>`;
  }

  function providerLabel(r) {
    // Provider is derived from the environment(s), not something you set
    // directly on the rule — shown muted so it doesn't read as editable.
    return `<span class="text-muted">${escapeHtml((r.providers || []).join(", "))}</span>`;
  }

  function parseEnvironments(raw) {
    const trimmed = (raw || "").trim();
    if (!trimmed || trimmed === "*") return "*";
    return trimmed.split(",").map((e) => e.trim()).filter(Boolean);
  }

  function currentFilters() {
    const q = qEl.value.trim().toLowerCase();
    const envs = ms.env?.getSelected() || [];
    const providers = ms.provider?.getSelected() || [];
    return { q, envs, providers };
  }

  function applyFilters(rules) {
    const { q, envs, providers } = currentFilters();
    const filtered = rules.filter((r) => {
      if (envs.length && !(r.environments || []).some((e) => envs.includes(e))) return false;
      if (providers.length && !(r.providers || []).some((p) => providers.includes(p))) return false;
      if (q) {
        const haystack = [r.check_id, r.reason, r.account, r.author].join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    return sortRules(filtered);
  }

  function sortRules(rules) {
    const keyFn = SORTABLE_COLUMNS[sortKey] || SORTABLE_COLUMNS.date;
    const sorted = rules.slice().sort((a, b) => {
      const av = keyFn(a);
      const bv = keyFn(b);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }

  function sortableHeader(label, key) {
    const active = sortKey === key;
    const arrow = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
    return `<th class="sortable-th${active ? " active" : ""}" data-sort-key="${key}">${label}${arrow}</th>`;
  }

  function wireSortableHeaders() {
    groupsEl.querySelectorAll(".sortable-th").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sortKey;
        if (sortKey === key) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortKey = key;
          sortDir = "asc";
        }
        renderFiltered();
      });
    });
  }

  function renderFiltered() {
    renderRows(applyFilters(allRules), allRules.length);
  }

  function render(rules) {
    allRules = rules;
    renderFiltered();
  }

  function renderRows(rules, totalCount) {
    const totalMatches = rules.reduce((sum, r) => sum + (r.match_count || 0), 0);

    if (!allRules.length) {
      groupsEl.innerHTML = `<p class="subtle">No mute rules anywhere yet.</p>`;
      return;
    }
    if (!rules.length) {
      groupsEl.innerHTML = `<p class="subtle">No mute rules match these filters.</p>`;
      return;
    }

    const rows = rules
      .map(
        (r) => `
      <tr class="rule-row" data-key="${escapeHtml(ruleKey(r))}" title="Click to see which findings this rule mutes">
        <td>${envLabel(r)}</td>
        <td>${providerLabel(r)}</td>
        <td><code>${escapeHtml(r.check_id)}</code></td>
        <td><span class="count-chip">${(r.match_count ?? "–").toLocaleString?.() ?? r.match_count}</span></td>
        <td class="wrap">${escapeHtml(r.reason)}</td>
        <td>${escapeHtml(r.author)}</td>
        <td>${escapeHtml(r.date)}</td>
        <td class="actions-cell">
          <div class="actions-cell-inner">
            <button type="button" class="icon-btn secondary edit-btn" data-key="${escapeHtml(ruleKey(r))}" title="Edit" aria-label="Edit">${ICON_EDIT}</button>
            <button type="button" class="icon-btn danger remove-btn" data-key="${escapeHtml(ruleKey(r))}" title="Remove" aria-label="Remove">${ICON_REMOVE}</button>
          </div>
        </td>
      </tr>
      <tr class="rule-preview-row" data-preview-for="${escapeHtml(ruleKey(r))}" hidden>
        <td colspan="8"><div class="mute-preview"></div></td>
      </tr>
      <tr class="rule-edit-row" data-edit-for="${escapeHtml(ruleKey(r))}" hidden>
        <td colspan="8"><div class="mute-form-slot"></div></td>
      </tr>`
      )
      .join("");

    const filtered = rules.length !== totalCount;
    const summaryText = filtered
      ? `${rules.length} of ${totalCount} mute rules shown, muting ${totalMatches.toLocaleString()} finding${totalMatches === 1 ? "" : "s"}`
      : `${rules.length} mute rule${rules.length === 1 ? "" : "s"}, muting ${totalMatches.toLocaleString()} finding${totalMatches === 1 ? "" : "s"} right now`;

    groupsEl.innerHTML = `
      <div class="result-summary">${summaryText}</div>
      <div class="table-wrap">
        <table id="rules-table">
          <thead>
            <tr>
              <th>Environment</th><th>Provider</th>
              ${sortableHeader("Check ID", "check_id")}
              ${sortableHeader("Matches", "match_count")}
              ${sortableHeader("Reason", "reason")}
              ${sortableHeader("Author", "author")}
              ${sortableHeader("Updated", "date")}
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    wireRowActions();
    wireSortableHeaders();
  }

  function findRule(key) {
    return allRules.find((r) => ruleKey(r) === key);
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
  }

  function wireRowActions() {
    groupsEl.querySelectorAll(".remove-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const rule = findRule(btn.dataset.key);
        if (!rule) return;
        const isAll = rule.environments_raw && (rule.environments_raw === "*" || (Array.isArray(rule.environments_raw) && rule.environments_raw.length === 1 && rule.environments_raw[0] === "*"));
        const envLabelText = isAll
          ? "all environments"
          : rule.environments.length > 1
          ? `${rule.environments.length} environments`
          : rule.environments[0];
        if (!confirm(`Remove mute rule for ${rule.check_id} in ${envLabelText}?`)) return;
        const params = new URLSearchParams({ account: rule.account, check_id: rule.check_id, rule_index: rule.rule_index });
        await fetch(`/api/mutelist?${params.toString()}`, { method: "DELETE" });
        load();
      });
    });

    groupsEl.querySelectorAll(".edit-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const rule = findRule(btn.dataset.key);
        if (!rule) return;
        toggleInlineEdit(rule);
      });
    });

    groupsEl.querySelectorAll("tr.rule-row").forEach((tr) => {
      tr.addEventListener("click", async () => {
        const key = tr.dataset.key;
        const rule = findRule(key);
        if (!rule) return;
        const row = groupsEl.querySelector(`.rule-preview-row[data-preview-for="${cssEscape(key)}"]`);
        const editRow = groupsEl.querySelector(`.rule-edit-row[data-edit-for="${cssEscape(key)}"]`);
        // Only one preview surface per row at a time: opening the row-click
        // preview always closes that row's inline edit form (which has its
        // own live preview) — otherwise the two could show different
        // numbers for the same rule at once.
        if (editRow && !editRow.hidden) {
          editRow.hidden = true;
          row.hidden = true;
          return;
        }
        if (!row.hidden) {
          row.hidden = true;
          return;
        }
        row.hidden = false;
        const container = row.querySelector(".mute-preview");
        await loadRowPreview(container, rule, 0);
      });
    });
  }

  // Same multi-environment preview the inline edit form uses, so the two
  // never show different results for the same rule — samples are tagged
  // with their source environment across all of the rule's environments,
  // not just the first one. `step` controls the sample limit (0 = default
  // 25, N>=1 = N * PREVIEW_PAGE_SIZE) and is incremented/reset by the
  // "…show N more / show fewer" link rendered inside renderMutePreview.
  async function loadRowPreview(container, rule, step) {
    renderMutePreview(container, null);
    const limit = step > 0 ? step * PREVIEW_PAGE_SIZE : PREVIEW_DEFAULT_LIMIT;
    const res = await fetch(`/api/mutelist/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        check_id: rule.check_id,
        account: rule.account,
        resources: rule.resources,
        regions: rule.regions,
        environments: rule.environments,
        limit,
      }),
    });
    const data = await res.json();
    renderMutePreview(container, data, {
      step,
      onToggle: (next) => loadRowPreview(container, rule, next),
      onRowClick: showFindingFromSample,
    });
  }

  // Inline edit: opens a form directly under the row being edited (not the
  // shared top-of-page Add panel), so editing a rule far down a long table
  // doesn't feel like it "jumped" somewhere else on the page.
  function toggleInlineEdit(rule) {
    const key = ruleKey(rule);
    const editRow = groupsEl.querySelector(`.rule-edit-row[data-edit-for="${cssEscape(key)}"]`);
    const previewRow = groupsEl.querySelector(`.rule-preview-row[data-preview-for="${cssEscape(key)}"]`);
    if (previewRow) previewRow.hidden = true;

    const alreadyOpen = !editRow.hidden;
    // Only one inline edit row open at a time.
    groupsEl.querySelectorAll(".rule-edit-row").forEach((r) => (r.hidden = true));
    if (alreadyOpen) return;

    const slot = editRow.querySelector(".mute-form-slot");
    slot.innerHTML = `
      <form class="mute-inline-form">
        <div class="form-grid">
          <label>Environment <input name="environments" value="${escapeHtml(Array.isArray(rule.environments_raw) ? rule.environments_raw.join(", ") : rule.environments_raw)}" placeholder="* for all, or comma-separated" required></label>
          <label><span class="label-row">Check ID <span class="lock-hint">🔒 locked</span></span><input value="${escapeHtml(rule.check_id)}" readonly></label>
          <label>Account UID <input name="account" value="${escapeHtml(rule.account)}" placeholder="* for all accounts"></label>
          <label>Resource pattern(s) <input name="resources" value="${escapeHtml((rule.resources || ["*"]).join(", "))}" placeholder="* or comma-separated"></label>
          <label>Region pattern(s) <input name="regions" value="${escapeHtml((rule.regions || ["*"]).join(", "))}" placeholder="* or comma-separated"></label>
          <label>Author <input name="author" value="${escapeHtml(rule.author || "")}" placeholder="you@example.com"></label>
          <label class="span-two-thirds">Reason <input name="reason" value="${escapeHtml(rule.reason || "")}" required></label>
        </div>
        <div class="mute-preview"></div>
        <div class="form-row">
          <button type="submit">Save changes</button>
          <button type="button" class="secondary cancel-inline-edit-btn">Cancel</button>
        </div>
      </form>
    `;
    editRow.hidden = false;

    const editForm = slot.querySelector("form");
    const editPreviewEl = slot.querySelector(".mute-preview");
    editForm.addEventListener("click", (e) => e.stopPropagation());
    slot.querySelector(".cancel-inline-edit-btn").addEventListener("click", () => {
      editRow.hidden = true;
    });

    wireMutePreview(
      null,
      editForm,
      editPreviewEl,
      () => rule.check_id,
      () => parseEnvironments(editForm.environments.value),
      showFindingFromSample
    );

    editForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(editForm);
      const environments = parseEnvironments(fd.get("environments"));
      const newAccount = fd.get("account").trim() || "*";
      const body = {
        check_id: rule.check_id,
        account: newAccount,
        resources: fd.get("resources").trim() || "*",
        regions: fd.get("regions").trim() || "*",
        reason: fd.get("reason").trim(),
        author: fd.get("author").trim(),
        environments,
      };

      let res;
      if (rule.account !== newAccount) {
        // Account changed: a rule's identity (for update-in-place purposes)
        // includes its account, so this isn't an in-place update — remove
        // the old entry, then add a fresh one under the new account.
        const params = new URLSearchParams({ account: rule.account, check_id: rule.check_id, rule_index: rule.rule_index });
        await fetch(`/api/mutelist?${params.toString()}`, { method: "DELETE" });
        res = await fetch("/api/mutelist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        // Same account: update this specific rule in place rather than
        // adding a new one alongside it (a check can carry several
        // independent rules on the same account, e.g. muting different
        // resources for different reasons).
        res = await fetch("/api/mutelist", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, rule_index: rule.rule_index }),
        });
      }
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      editRow.hidden = true;
      load();
    });
  }

  addRuleBtn.addEventListener("click", () => {
    const opening = addRulePanel.hidden;
    addRulePanel.hidden = !opening;
    if (!opening) {
      form.reset();
      previewEl.innerHTML = "";
    }
  });

  cancelAddBtn.addEventListener("click", () => {
    form.reset();
    previewEl.innerHTML = "";
    addRulePanel.hidden = true;
  });

  const refreshPreview = wireMutePreview(
    null,
    form,
    previewEl,
    () => form.check_id.value,
    () => parseEnvironments(form.environments.value),
    showFindingFromSample
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const environments = parseEnvironments(fd.get("environments"));
    const body = {
      check_id: fd.get("check_id").trim(),
      account: fd.get("account").trim() || "*",
      resources: fd.get("resources").trim() || "*",
      regions: fd.get("regions").trim() || "*",
      reason: fd.get("reason").trim(),
      author: fd.get("author").trim(),
      environments,
    };

    const res = await fetch("/api/mutelist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
      return;
    }
    form.reset();
    previewEl.innerHTML = "";
    addRulePanel.hidden = true;
    load();
  });

  function populateFacets(rules) {
    const envs = new Set();
    const providers = new Set();
    rules.forEach((r) => {
      (r.environments || []).forEach((e) => envs.add(e));
      (r.providers || []).forEach((p) => providers.add(p));
    });
    knownEnvCount = envs.size;

    if (!ms.env) {
      ms.env = enhanceMultiselect(document.getElementById("f-env"), renderFiltered);
      ms.provider = enhanceMultiselect(document.getElementById("f-provider"), renderFiltered);
    }
    ms.env.setOptions(Array.from(envs).sort());
    ms.provider.setOptions(Array.from(providers).sort());
  }

  qEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderFiltered, 250);
  });

  async function load() {
    const res = await fetch("/api/mutes");
    const data = await res.json();
    populateFacets(data.rules);
    render(data.rules);
  }

  load();
})();
