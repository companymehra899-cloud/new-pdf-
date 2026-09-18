(function () {
  "use strict";

  const toolCards = document.querySelectorAll(".tool-card");
  const filters = document.querySelectorAll(".filter-chip");
  const searchInput = document.querySelector(".search-box input");

  function applyFilter(cat, query) {
    const q = String(query || "").trim().toLowerCase();
    toolCards.forEach((card) => {
      const matchCat = cat === "all" || card.dataset.cat === cat;
      const matchQ = !q || card.textContent.toLowerCase().includes(q);
      card.style.display = matchCat && matchQ ? "" : "none";
    });
  }

  let activeCat = "all";
  filters.forEach((chip) => {
    chip.addEventListener("click", () => {
      filters.forEach((c) => c.classList.toggle("is-active", c === chip));
      activeCat = chip.dataset.filter || "all";
      applyFilter(activeCat, searchInput ? searchInput.value : "");
    });
  });

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      applyFilter(activeCat, searchInput.value);
    });
  }

  const menuToggle = document.querySelector(".menu-toggle");
  const mainNav = document.getElementById("mainNav");
  if (menuToggle && mainNav) {
    menuToggle.addEventListener("click", () => mainNav.classList.toggle("open"));
    mainNav.querySelectorAll(".has-menu > .nav-link").forEach((btn) => {
      btn.addEventListener("click", () => btn.parentElement.classList.toggle("open"));
    });
  }
})();
