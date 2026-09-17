/* ============================================================
   Docu-Magic - client side PDF toolkit
   ============================================================ */
(function () {
  "use strict";

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const chooseBtn = document.getElementById("chooseFile");
  const fileListEl = document.getElementById("fileList");
  const toolCards = document.querySelectorAll(".tool-card");

  let selectedFiles = [];

  /* ---------- helpers ---------- */
  function isPdf(file) {
    return file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name));
  }

  function isImage(file) {
    return (
      file &&
      (/^image\/(png|jpeg|jpg)$/i.test(file.type) || /\.(png|jpe?g)$/i.test(file.name))
    );
  }

  function isSupported(file) {
    return isPdf(file) || isImage(file);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  /* ---------- file selection ---------- */
  function addFiles(fileList) {
    const incoming = Array.from(fileList).filter(isSupported);
    const rejected = Array.from(fileList).length - incoming.length;

    if (!incoming.length) {
      notify("Only PDF or image files are supported", "error");
      return;
    }
    const names = new Set(selectedFiles.map((f) => f.name + f.size));
    incoming.forEach((f) => {
      if (!names.has(f.name + f.size)) {
        selectedFiles.push(f);
        names.add(f.name + f.size);
      }
    });
    renderFiles();
    if (rejected > 0) notify(rejected + " unsupported file(s) skipped", "warn");
    if (incoming.length) stashAndOpen("edit");
  }

  function removeFile(index) {
    selectedFiles.splice(index, 1);
    renderFiles();
  }

  function renderFiles() {
    fileListEl.innerHTML = "";
    selectedFiles.forEach((file, i) => {
      const chip = document.createElement("div");
      chip.className = "file-chip";
      const label = document.createElement("span");
      label.textContent = file.name + " (" + formatSize(file.size) + ")";
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "\u00d7";
      close.setAttribute("aria-label", "Remove " + file.name);
      close.style.cssText = "font-size:16px;line-height:1;color:#ef5f92;font-weight:800;";
      close.addEventListener("click", () => removeFile(i));
      chip.append(label, close);
      fileListEl.appendChild(chip);
    });
  }

  /* ---------- drag & drop ---------- */
  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === "dragleave" && dropzone.contains(e.relatedTarget)) return;
      dropzone.classList.remove("dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  dropzone.addEventListener("click", (e) => {
    if (e.target.closest(".file-chip")) return;
    fileInput.click();
  });
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  chooseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
  });

  /* ---------- toast + modal ---------- */
  let toastTimer = null;
  function notify(message, type) {
    let toast = document.getElementById("toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "toast";
      Object.assign(toast.style, {
        position: "fixed",
        left: "50%",
        bottom: "28px",
        transform: "translateX(-50%)",
        background: "#16323f",
        color: "#fff",
        padding: "12px 22px",
        borderRadius: "999px",
        fontWeight: "700",
        fontSize: "15px",
        zIndex: "9999",
        boxShadow: "0 12px 28px rgba(0,0,0,.25)",
        opacity: "0",
        transition: "opacity .25s, transform .25s",
        pointerEvents: "none",
        maxWidth: "90vw",
        textAlign: "center",
      });
      document.body.appendChild(toast);
    }
    toast.style.background = type === "error" ? "#e14b6a" : type === "warn" ? "#e59a24" : "#16323f";
    toast.textContent = message;
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateX(-50%) translateY(-6px)";
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(-50%)";
    }, 2600);
  }

  function openStore() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("docu-magic", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function stashAndOpen(tool) {
    notify("Opening workspace...");
    const payload = { tool: tool, files: [] };
    for (const file of selectedFiles) {
      payload.files.push({
        name: file.name,
        type: file.type || (isPdf(file) ? "application/pdf" : "image/png"),
        data: await file.arrayBuffer(),
      });
    }
    try {
      const db = await openStore();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("pending", "readwrite");
        tx.objectStore("pending").put(payload, "current");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      window.location.href = "workspace.html?tool=" + encodeURIComponent(tool);
    } catch (err) {
      console.error(err);
      notify("Could not open workspace: " + err.message, "error");
    }
  }

  toolCards.forEach((card) => {
    card.addEventListener("click", async (e) => {
      const tool = card.dataset.tool;
      if (selectedFiles.length) {
        e.preventDefault();
        await stashAndOpen(tool);
      }
    });
  });

  /* ---------- search ---------- */
  const searchInput = document.querySelector(".search-box input");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      toolCards.forEach((card) => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(q) ? "" : "none";
      });
    });
  }

  /* ---------- mobile nav ---------- */
  const menuToggle = document.querySelector(".menu-toggle");
  const mainNav = document.getElementById("mainNav");
  if (menuToggle && mainNav) {
    menuToggle.addEventListener("click", () => mainNav.classList.toggle("open"));
    mainNav.querySelectorAll(".has-menu > .nav-link").forEach((btn) => {
      btn.addEventListener("click", () => btn.parentElement.classList.toggle("open"));
    });
  }
})();
