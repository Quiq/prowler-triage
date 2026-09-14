(function () {
  const root = document.documentElement;
  const switcher = document.getElementById("theme-switcher");
  if (!switcher) return;

  const buttons = Array.from(switcher.querySelectorAll("[data-theme-choice]"));

  function currentChoice() {
    try {
      const t = localStorage.getItem("theme");
      if (t === "light" || t === "dark") return t;
    } catch (e) {}
    return "auto";
  }

  function applyChoice(choice) {
    if (choice === "light" || choice === "dark") {
      root.setAttribute("data-theme", choice);
      try {
        localStorage.setItem("theme", choice);
      } catch (e) {}
    } else {
      root.removeAttribute("data-theme");
      try {
        localStorage.removeItem("theme");
      } catch (e) {}
    }
    buttons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeChoice === choice);
    });
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => applyChoice(btn.dataset.themeChoice));
  });

  applyChoice(currentChoice());
})();
