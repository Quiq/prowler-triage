(function () {
  const env = window.ENV;
  let debounceTimer;
  const ms = {};

  const els = {
    q: document.getElementById("q"),
    mute: document.getElementById("f-mute"),
    groups: document.getElementById("groups"),
    summary: document.getElementById("summary"),
    detail: document.getElementById("detail"),
    detailBody: document.getElementById("detail-body"),
    detailClose: document.getElementById("detail-close"),
    detailBackdrop: document.getElementById("detail-backdrop"),
    muteModalBackdrop: document.getElementById("mute-modal-backdrop"),
    muteModalBody: document.getElementById("mute-modal-body"),
    muteModalClose: document.getElementById("mute-modal-close"),
  };

  const DEFAULT_STATUS = ["FAIL"];

  function currentFilters() {
    const f = new URLSearchParams();
    if (els.q.value.trim()) f.set("q", els.q.value.trim());
    if (els.mute.value) f.set("mute_state", els.mute.value);
    ["status", "severity", "service", "region", "account"].forEach((key) => {
      (ms[key]?.getSelected() || []).forEach((v) => f.append(key, v));
    });
    return f;
  }

  const RESOURCE_PAGE_SIZE = 500;
  const visibleCounts = {};

  function renderGroups(groups) {
    const statuses = ms.status?.getSelected() || [];
    const label = statuses.length === 1 ? statuses[0].toLowerCase() : "matching";
    els.summary.textContent = `${groups.length.toLocaleString()} unique ${label} groups`;

    els.groups.innerHTML = groups
      .map((g, i) => {
        const shownCount = Math.min(visibleCounts[i] || RESOURCE_PAGE_SIZE, g.resources.length);
        const resourceRows = g.resources
          .slice(0, shownCount)
          .map(
            (r, ri) => `
          <tr class="resource-row" data-idx="${i}" data-ri="${ri}">
            <td><span class="badge badge-${r.STATUS}">${r.STATUS}</span></td>
            <td>${resourceCell(r)}</td>
            <td>${escapeHtml(r.ACCOUNT_NAME || "")}</td>
            <td>${escapeHtml(r.REGION || "")}</td>
            <td class="wrap">${escapeHtml(r.STATUS_EXTENDED || "")}</td>
            <td class="muted-cell">${r.EFFECTIVE_MUTED ? `<span class="muted-yes">yes</span>` : `<button type="button" class="secondary mute-resource-btn" data-idx="${i}" data-ri="${ri}">Mute</button>`}</td>
          </tr>`
          )
          .join("");
        const resourceMore = g.resources.length - shownCount;
        const resourcePager = `
          ${resourceMore > 0 ? `<p class="preview-status">…and ${resourceMore.toLocaleString()} more — <button type="button" class="link-btn resource-more-btn" data-idx="${i}">show ${Math.min(resourceMore, RESOURCE_PAGE_SIZE).toLocaleString()} more</button></p>` : ""}
          ${shownCount > RESOURCE_PAGE_SIZE ? `<p class="preview-status"><button type="button" class="link-btn resource-fewer-btn" data-idx="${i}">Show fewer</button></p>` : ""}
        `;

        const statusBadges = (g.statuses || [])
          .map((s) => `<span class="badge badge-${s}">${s} (${g.status_counts[s]})</span>`)
          .join(" ");

        const totalMuteRelevant = g.unmuted_count + g.muted_count;
        const unmutedPct = totalMuteRelevant ? (g.unmuted_count / totalMuteRelevant * 100) : 0;
        const mutedPct = totalMuteRelevant ? (g.muted_count / totalMuteRelevant * 100) : 0;
        // Color reflects both mute state and whether the group has any
        // actual failure in it — a fully-passing group is never red/orange
        // (nothing to fix), just a lighter/darker gray depending on mute
        // state, which doesn't change its risk since it's already passing.
        const hasFail = (g.status_counts && g.status_counts.FAIL) > 0;
        let meterState;
        if (hasFail) {
          meterState = g.unmuted_count === 0 ? "fail-muted" : g.muted_count === 0 ? "fail-unmuted" : "fail-partial";
        } else {
          meterState = g.muted_count > 0 ? "pass-muted" : "pass-unmuted";
        }
        const muteMeter = totalMuteRelevant
          ? `
          <span class="mute-meter mute-meter-${meterState}" title="${g.unmuted_count} unmuted, ${g.muted_count} muted">
            <span class="mute-meter-track">
              <span class="mute-meter-seg mute-meter-unmuted" style="width:${unmutedPct}%"></span>
              <span class="mute-meter-seg mute-meter-muted" style="width:${mutedPct}%"></span>
            </span>
            <span class="mute-meter-label">${g.muted_count} of ${totalMuteRelevant} muted</span>
          </span>`
          : "";

        const titleAttr = escapeHtml(mdSnippetText(g.description, 200));

        const whatIsThis = (g.description || g.risk || g.recommendation)
          ? `
          <div class="group-explain">
            ${g.description ? `<h4>What is this?</h4><div class="md">${mdLite(g.description)}</div>` : ""}
            ${g.risk ? `<h4>Risk</h4><div class="md">${mdLite(g.risk)}</div>` : ""}
            ${g.recommendation ? `<h4>Recommendation</h4><div class="md">${mdLite(g.recommendation)}</div>` : ""}
            ${g.recommendation_url ? `<p><a href="${escapeHtml(g.recommendation_url)}" target="_blank" rel="noopener">${escapeHtml(g.recommendation_url)}</a></p>` : ""}
          </div>`
          : "";

        return `
        <div class="group-card" data-idx="${i}">
          <div class="group-head">
            <span class="status-badges">${statusBadges}</span>
            <span class="pill-sev sev-${g.severity}">${g.severity || ""}</span>
            <span class="group-title" ${titleAttr ? `title="${titleAttr}"` : ""}>${escapeHtml(g.check_title)}</span>
            <span class="group-meta">
              ${muteMeter}
              <span><code>${escapeHtml(g.check_id)}</code></span>
            </span>
            ${g.unmuted_count ? `<button type="button" class="secondary mute-check-btn" data-idx="${i}">Mute</button>` : ""}
          </div>
          <div class="group-body">
            ${whatIsThis}
            <table class="compact-table">
              <thead><tr><th>Status</th><th>Resource</th><th>Account</th><th>Region</th><th>Status detail</th><th>Muted</th></tr></thead>
              <tbody>${resourceRows}</tbody>
            </table>
            ${resourcePager}
          </div>
        </div>`;
      })
      .join("");

    els.groups.querySelectorAll(".group-head").forEach((head) => {
      head.addEventListener("click", () => {
        head.nextElementSibling.classList.toggle("open");
      });
    });

    els.groups.querySelectorAll(".mute-check-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const g = groups[Number(btn.dataset.idx)];
        openMuteForm(g, { resource: "*", account: "*" });
      });
    });

    els.groups.querySelectorAll(".mute-resource-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const g = groups[Number(btn.dataset.idx)];
        const r = g.resources[Number(btn.dataset.ri)];
        openMuteForm(g, {
          resource: r.RESOURCE_UID || "*",
          account: findAccountUid(r.ACCOUNT_NAME) || "*",
        });
      });
    });

    els.groups.querySelectorAll(".resource-row").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const g = groups[Number(tr.dataset.idx)];
        const r = g.resources[Number(tr.dataset.ri)];
        showDetail(g, r);
      });
    });

    els.groups.querySelectorAll(".resource-more-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.idx);
        visibleCounts[idx] = (visibleCounts[idx] || RESOURCE_PAGE_SIZE) + RESOURCE_PAGE_SIZE;
        renderGroups(groups);
      });
    });

    els.groups.querySelectorAll(".resource-fewer-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.idx);
        delete visibleCounts[idx];
        renderGroups(groups);
      });
    });
  }

  const findingDetail = wireFindingDetail(els);

  // Merges the group's shared check-level fields (title, description, risk,
  // recommendation — same for every resource in the group) with this one
  // resource's own fields, so the popup shows everything a full finding
  // record would.
  function showDetail(g, r) {
    findingDetail.show({
      ...r,
      SEVERITY: g.severity,
      CHECK_TITLE: g.check_title,
      CHECK_ID: g.check_id,
      SERVICE_NAME: g.service_name,
      DESCRIPTION: g.description,
      RISK: g.risk,
      REMEDIATION_RECOMMENDATION_TEXT: g.recommendation,
      REMEDIATION_RECOMMENDATION_URL: g.recommendation_url,
    });
  }

  let accountFacets = [];

  function findAccountUid(accountName) {
    const match = accountFacets.find((a) => a.name === accountName);
    return match ? match.uid : null;
  }

  function openMuteForm(group, defaults) {
    els.muteModalBody.innerHTML = `
      <h2>Mute ${escapeHtml(group.check_title || group.check_id)}</h2>
      <form class="mute-inline-form">
        <div class="form-row">
          <label>Check ID <input name="check_id" value="${escapeHtml(group.check_id)}" readonly></label>
          <label>Account UID <input name="account" value="${escapeHtml(defaults.account)}" placeholder="*"></label>
        </div>
        <div class="form-row">
          <label>Resource pattern(s) <input name="resources" value="${escapeHtml(defaults.resource)}" placeholder="* or comma-separated, e.g. www*.example.com"></label>
          <label>Region pattern(s) <input name="regions" value="*" placeholder="*"></label>
        </div>
        <div class="mute-preview"></div>
        <div class="form-row">
          <label class="reason-field">Reason <input name="reason" required placeholder="Why this is accepted risk / false positive"></label>
          <label class="author-field">Author <input name="author" placeholder="you@example.com"></label>
        </div>
        <div class="form-row">
          <button type="submit">Confirm mute</button>
          <button type="button" class="secondary cancel-mute-btn">Cancel</button>
        </div>
      </form>
    `;
    const form = els.muteModalBody.querySelector("form");
    const previewEl = form.querySelector(".mute-preview");
    form.querySelector(".cancel-mute-btn").addEventListener("click", closeMuteModal);

    els.muteModalBackdrop.hidden = false;

    wireMutePreview(env, form, previewEl, () => group.check_id);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = {
        check_id: group.check_id,
        account: fd.get("account").trim() || "*",
        resources: fd.get("resources").trim() || "*",
        regions: fd.get("regions").trim() || "*",
        reason: fd.get("reason").trim(),
        author: fd.get("author").trim(),
      };
      const res = await fetch(`/api/${env}/mutelist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      closeMuteModal();
      load();
    });
  }

  function closeMuteModal() {
    els.muteModalBackdrop.hidden = true;
    els.muteModalBody.innerHTML = "";
  }

  els.muteModalClose.addEventListener("click", closeMuteModal);
  els.muteModalBackdrop.addEventListener("click", (e) => {
    if (e.target === els.muteModalBackdrop) closeMuteModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.muteModalBackdrop.hidden) closeMuteModal();
  });

  async function load() {
    const f = currentFilters();
    const res = await fetch(`/api/${env}/unique?${f.toString()}`);
    const data = await res.json();
    renderGroups(data.groups);
  }

  async function loadFacets() {
    const res = await fetch(`/api/${env}/facets`);
    const facets = await res.json();
    ms.status = enhanceMultiselect(document.getElementById("f-status"), onFilterChange);
    ms.severity = enhanceMultiselect(document.getElementById("f-severity"), onFilterChange);
    ms.service = enhanceMultiselect(document.getElementById("f-service"), onFilterChange);
    ms.region = enhanceMultiselect(document.getElementById("f-region"), onFilterChange);
    ms.account = enhanceMultiselect(document.getElementById("f-account"), onFilterChange);

    ms.status.setOptions(facets.status, DEFAULT_STATUS);
    ms.severity.setOptions(facets.severity);
    ms.service.setOptions(facets.service);
    ms.region.setOptions(facets.region);
    ms.account.setOptions(facets.account.map((a) => ({ value: a.uid, label: a.name || a.uid })));
    accountFacets = facets.account;
  }

  function onFilterChange() {
    load();
  }

  els.q.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onFilterChange, 300);
  });
  els.mute.addEventListener("change", onFilterChange);

  loadFacets().then(load);
})();
