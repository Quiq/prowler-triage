// Turns a <select multiple> into a checkbox-dropdown button, keeping the
// original <select> in sync (so plain `select.value`/options code still works
// for reading state, and setOptions can repopulate it).
function enhanceMultiselect(selectEl, onChange) {
  const placeholder = selectEl.dataset.placeholder || "Filter";
  selectEl.style.display = "none";

  const wrap = document.createElement("div");
  wrap.className = "ms-wrap";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ms-btn secondary";
  btn.textContent = placeholder;

  const panel = document.createElement("div");
  panel.className = "ms-panel";
  panel.hidden = true;

  wrap.appendChild(btn);
  wrap.appendChild(panel);
  selectEl.parentNode.insertBefore(wrap, selectEl.nextSibling);

  function selected() {
    return Array.from(selectEl.selectedOptions).map((o) => o.value);
  }

  function updateLabel() {
    const n = selected().length;
    btn.textContent = n ? `${placeholder} (${n})` : placeholder;
  }

  function renderPanel() {
    panel.innerHTML = "";
    Array.from(selectEl.options).forEach((opt) => {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = opt.value;
      cb.checked = opt.selected;
      cb.addEventListener("change", () => {
        opt.selected = cb.checked;
        updateLabel();
        onChange && onChange(selected());
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(opt.textContent));
      panel.appendChild(label);
    });
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) panel.hidden = true;
  });

  let everPopulated = false;

  const api = {
    // items: array of strings, or {value,label} objects.
    // defaultSelected: values pre-checked the first time this select is
    // populated (e.g. status=["FAIL"]); ignored on later calls so it never
    // overrides a choice the user already made.
    setOptions(items, defaultSelected) {
      const prevSelected = new Set(
        everPopulated ? selected() : defaultSelected || []
      );
      selectEl.innerHTML = "";
      items.forEach((item) => {
        const value = typeof item === "string" ? item : item.value;
        const label = typeof item === "string" ? item : item.label;
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        opt.selected = prevSelected.has(value);
        selectEl.appendChild(opt);
      });
      everPopulated = true;
      renderPanel();
      updateLabel();
    },
    getSelected: selected,
  };

  renderPanel();
  updateLabel();
  return api;
}
