// Shared finding-detail popup, used by Grouped Findings (clicking a resource
// row, where the full record is already in hand) and the Mutelist page
// (clicking a preview row, where only a few columns are known up front and
// the rest is fetched by FINDING_UID). Renders into #detail/#detail-backdrop,
// which must exist on the page.
function severityBadge(sev) {
  if (!sev) return "";
  return `<span class="pill-sev sev-${sev}">${sev}</span>`;
}

function detailLinkify(url) {
  if (!url) return "";
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
}

function detailSection(title, raw, plain) {
  if (!raw) return "";
  const body = plain ? `<p class="wrap">${escapeHtml(raw)}</p>` : `<div class="wrap md">${mdLite(raw)}</div>`;
  return `<h3>${title}</h3>${body}`;
}

// `f` is a flat finding record: STATUS, SEVERITY, CHECK_ID, CHECK_TITLE,
// FINDING_UID, SERVICE_NAME, RESOURCE_NAME/UID/TYPE, ACCOUNT_NAME/UID,
// REGION, CATEGORIES, EFFECTIVE_MUTED, CUSTOM_MUTE_REASON, STATUS_EXTENDED,
// DESCRIPTION, RISK, REMEDIATION_RECOMMENDATION_TEXT/URL, NOTES,
// RELATED_URL, COMPLIANCE — the shape returned by get_finding_detail() and
// (with the shared fields already merged in) by Grouped Findings' own
// group+resource combo.
function renderFindingDetail(els, f) {
  const rows = [
    ["Status", `<span class="badge badge-${f.STATUS}">${f.STATUS}</span>`],
    ["Severity", severityBadge(f.SEVERITY)],
    ["Check ID", `<code>${escapeHtml(f.CHECK_ID || "")}</code>`],
    ["Finding UID", `<code>${escapeHtml(f.FINDING_UID || "")}</code>`],
    ["Service", `${escapeHtml(f.SERVICE_NAME || "")}`],
    ["Resource", `<code>${escapeHtml(f.RESOURCE_UID || f.RESOURCE_NAME || "")}</code>`],
    ["Resource type", escapeHtml(f.RESOURCE_TYPE || "")],
    ["Account", `${f.ACCOUNT_NAME && f.ACCOUNT_NAME !== f.ACCOUNT_UID ? escapeHtml(f.ACCOUNT_NAME) + " " : ""}<code>${escapeHtml(f.ACCOUNT_UID || "")}</code>`],
    ["Region", escapeHtml(f.REGION || "")],
    ["Categories", escapeHtml(f.CATEGORIES || "")],
    [
      "Muted",
      `<span class="badge ${f.EFFECTIVE_MUTED ? "badge-muted-yes" : "badge-muted-no"}">${f.EFFECTIVE_MUTED ? "yes" : "no"}</span>${f.CUSTOM_MUTE_REASON ? " Reason: " + escapeHtml(f.CUSTOM_MUTE_REASON) : ""}`,
    ],
  ];

  els.detailBody.innerHTML = `
    <h2>${escapeHtml(f.CHECK_TITLE || f.CHECK_ID || "")}</h2>
    <table class="detail-fields">
      <tbody>
        ${rows.map(([label, value]) => `<tr><th>${label}</th><td>${value || "—"}</td></tr>`).join("")}
      </tbody>
    </table>
    ${detailSection("Status detail", f.STATUS_EXTENDED, true)}
    ${detailSection("Description", f.DESCRIPTION)}
    ${detailSection("Risk", f.RISK)}
    ${detailSection("Recommendation", f.REMEDIATION_RECOMMENDATION_TEXT)}
    ${f.REMEDIATION_RECOMMENDATION_URL ? `<h3>Recommendation link</h3><p class="wrap">${detailLinkify(f.REMEDIATION_RECOMMENDATION_URL)}</p>` : ""}
    ${detailSection("Notes", f.NOTES, true)}
    ${f.RELATED_URL ? `<h3>Related URL</h3><p class="wrap">${detailLinkify(f.RELATED_URL)}</p>` : ""}
    ${detailSection("Compliance", f.COMPLIANCE, true)}
  `;
  els.detail.hidden = false;
  els.detailBackdrop.hidden = false;
}

function closeFindingDetail(els) {
  els.detail.hidden = true;
  els.detailBackdrop.hidden = true;
}

// Wires the close button/backdrop-click/Escape handlers once. `loading`
// (optional) is shown immediately while an async fetch (Mutelist page's
// by-FINDING_UID lookup) is in flight.
function wireFindingDetail(els) {
  els.detailClose.addEventListener("click", () => closeFindingDetail(els));
  els.detailBackdrop.addEventListener("click", () => closeFindingDetail(els));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.detail.hidden) closeFindingDetail(els);
  });

  return {
    show: (f) => renderFindingDetail(els, f),
    showLoading: () => {
      els.detailBody.innerHTML = `<p class="preview-status">Loading…</p>`;
      els.detail.hidden = false;
      els.detailBackdrop.hidden = false;
    },
    close: () => closeFindingDetail(els),
  };
}
