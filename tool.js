(function () {
  "use strict";

  const catalog = window.DM_TOOLS || {};
  const params = new URLSearchParams(window.location.search);
  const toolId = params.get("id") || "edit";
  const tool = catalog[toolId] || catalog.edit || {
    title: "Upload",
    heading: "UPLOAD FILE",
    kicker: "Tool",
    desc: "Choose a file to continue.",
    accept: "application/pdf",
    hint: "PDF files",
    workspace: toolId,
  };

  document.title = tool.title + " - Docu-Magic";
  const kickerEl = document.getElementById("toolKicker");
  const headingEl = document.getElementById("toolHeading");
  const descEl = document.getElementById("toolDesc");
  const hintEl = document.getElementById("toolHint");
  if (kickerEl) kickerEl.textContent = tool.kicker || "Tool";
  if (headingEl) headingEl.textContent = tool.heading || "UPLOAD FILE";
  if (descEl) descEl.textContent = tool.desc || "Choose a file to continue.";
  if (hintEl) hintEl.textContent = "or drop files here  ·  " + String(tool.hint || "PDF files");

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const chooseBtn = document.getElementById("chooseFile");
  const fileListEl = document.getElementById("fileList");

  if (fileInput) fileInput.accept = tool.accept || "application/pdf";
  let selectedFiles = [];
  let opening = false;

  function extOf(name) {
    const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  }

  function isAllowed(file) {
    if (!file) return false;
    const name = String(file.name || "").toLowerCase();
    const type = String(file.type || "").toLowerCase();
    const ext = extOf(name);
    const accept = String(tool.accept || "application/pdf")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (!accept.length) return true;

    const pdfOk = accept.some((r) => r === "application/pdf" || r === ".pdf" || r === "pdf");
    if (pdfOk && (type === "application/pdf" || type === "application/x-pdf" || ext === "pdf")) {
      return true;
    }

    return accept.some((rule) => {
      if (rule.startsWith(".")) return name.endsWith(rule);
      if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
      if (rule.includes("/")) {
        const subtype = rule.split("/")[1];
        return type === rule || ext === subtype || (subtype === "jpeg" && ext === "jpg");
      }
      return ext === rule.replace(".", "");
    });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

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
    clearTimeout(notify._t);
    notify._t = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(-50%)";
    }, 2400);
  }

  function setBusy(on) {
    if (!dropzone) return;
    dropzone.classList.toggle("is-busy", on);
    dropzone.style.pointerEvents = on ? "none" : "";
    dropzone.style.opacity = on ? "0.72" : "";
  }

  function renderFiles() {
    if (!fileListEl) return;
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
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedFiles.splice(i, 1);
        renderFiles();
      });
      chip.append(label, close);
      fileListEl.appendChild(chip);
    });
  }

  function addFiles(list) {
    const incoming = Array.from(list || []).filter(isAllowed);
    if (!incoming.length) {
      notify("This tool needs " + String(tool.hint || "a PDF file").toLowerCase(), "error");
      return;
    }
    incoming.forEach((f) => {
      if (!selectedFiles.some((x) => x.name === f.name && x.size === f.size)) selectedFiles.push(f);
    });
    renderFiles();
    openWorkspace();
  }

  function openStore() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("docu-magic", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB failed"));
    });
  }

  async function openWorkspace() {
    if (opening || !selectedFiles.length) return;
    opening = true;
    setBusy(true);
    notify("Opening workspace...");
    try {
      const payload = { tool: tool.workspace || toolId, files: [] };
      for (const file of selectedFiles) {
        const buffer = await file.arrayBuffer();
        payload.files.push({
          name: file.name,
          type: file.type || (extOf(file.name) === "pdf" ? "application/pdf" : "application/octet-stream"),
          data: buffer,
        });
      }
      const db = await openStore();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("pending", "readwrite");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error("Could not save file"));
        tx.onabort = () => reject(tx.error || new Error("Save aborted"));
        tx.objectStore("pending").put(payload, "current");
      });
      try { sessionStorage.setItem("dm-selected-tool", payload.tool); } catch (e) {}
      window.location.assign("workspace.html?tool=" + encodeURIComponent(payload.tool));
    } catch (err) {
      opening = false;
      setBusy(false);
      console.error(err);
      notify("Could not open workspace: " + (err && err.message ? err.message : err), "error");
    }
  }

  if (dropzone) {
    ["dragenter", "dragover"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add("dragover");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("dragover");
      })
    );
    dropzone.addEventListener("drop", (e) => {
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
    dropzone.addEventListener("click", (e) => {
      if (e.target.closest(".file-chip") || e.target.closest("#chooseFile")) return;
      if (fileInput) fileInput.click();
    });
  }

  if (chooseBtn) {
    chooseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (fileInput) fileInput.click();
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", () => {
      addFiles(fileInput.files);
      fileInput.value = "";
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

  renderFiles();
})();
