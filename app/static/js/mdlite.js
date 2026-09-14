// Minimal Markdown-ish renderer for the subset Prowler actually emits in its
// Description/Risk/Recommendation fields: **bold**, `code`, "- " bullet
// lists, and paragraph breaks on blank lines. Input is escaped first, so
// this never introduces raw HTML from finding data.
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function mdInline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Non-greedy across any character (not just non-*) so bold still
    // matches when its content contains inline code that itself contains
    // an asterisk, e.g. "**Unrestricted `*:*` access**" — the backtick
    // substitution above turns that into "**Unrestricted <code>*:*</code>
    // access**", and a `[^*]+` bold pattern would fail to match at all.
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function mdLite(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";

  const blocks = text.split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      const isList = lines.length > 0 && lines.every((l) => /^[-*]\s+/.test(l));
      if (isList) {
        const items = lines.map((l) => `<li>${mdInline(l.replace(/^[-*]\s+/, ""))}</li>`).join("");
        return `<ul>${items}</ul>`;
      }
      return `<p>${lines.map(mdInline).join("<br>")}</p>`;
    })
    .join("");
}

// Plain-text (unescaped) snippet, for use as an attribute value (e.g.
// title="...") rather than inner HTML — the browser does not re-decode
// entities inside attribute values on display.
function mdSnippetText(raw, maxLen) {
  const text = String(raw ?? "")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).replace(/\s+\S*$/, "") + "…";
}

function mdSnippet(raw, maxLen) {
  return escapeHtml(mdSnippetText(raw, maxLen));
}
