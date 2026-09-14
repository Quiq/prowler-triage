(function () {
  document.querySelectorAll(".env-card[data-href]").forEach((card) => {
    const go = () => {
      window.location.href = card.dataset.href;
    };
    card.addEventListener("click", go);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });
  });
})();
