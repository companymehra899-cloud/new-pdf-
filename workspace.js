(function () {
  "use strict";

  const PDFLib = window.PDFLib || {};
  const pdfjsLib = window.pdfjsLib;

  if (pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const state = {
    sources: [],
    pages: [],
    selected: new Set(),
    zoom: 1,
    current: 0,
    tool: "select",
    selectedTool: "",
    pendingImage: null,
    pendingSignature: null,
    history: [],
    future: [],
  };

  const el = {
    fileName: document.getElementById("fileName"),
    fileMeta: document.getElementById("fileMeta"),
    thumbs: document.getElementById("thumbs"),
    pageStack: document.getElementById("pageStack"),
    pageNumber: document.getElementById("pageNumber"),
    pageTotal: document.getElementById("pageTotal"),
    zoomLabel: document.getElementById("zoomLabel"),
    selectionInfo: document.getElementById("selectionInfo"),
    statusText: document.getElementById("statusText"),
    statusMode: document.getElementById("statusMode"),
    wsFileList: document.getElementById("wsFileList"),
    infoPages: document.getElementById("infoPages"),
    infoSize: document.getElementById("infoSize"),
    infoRotation: document.getElementById("infoRotation"),
    infoAnnots: document.getElementById("infoAnnots"),
    savedBadge: document.getElementById("savedBadge"),
    dropHint: document.getElementById("dropHint"),
    fileInput: document.getElementById("wsFileInput"),
    imageInput: document.getElementById("wsImageInput"),
    modal: document.getElementById("modal"),
    modalTitle: document.getElementById("modalTitle"),
    modalBody: document.getElementById("modalBody"),
    modalFoot: document.getElementById("modalFoot"),
  };

  const BASE_SCALE = 1.35;

  /* ================= helpers ================= */

  let toastEl = null;
  function toast(message, isError) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "ws-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.toggle("is-error", !!isError);
    toastEl.classList.add("is-visible");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("is-visible"), 2400);
  }

  function status(text) {
    el.statusText.textContent = text;
  }

  let savedTimer = null;
  function markSaved() {
    el.savedBadge.classList.remove("is-hidden");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.savedBadge.classList.add("is-hidden"), 1600);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function baseName(name) {
    return String(name).replace(/\.[a-z0-9]+$/i, "") || "document";
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function bytesFromDataUrl(dataUrl) {
    const base64 = dataUrl.split(",")[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function totalRotation(entry) {
    return (((entry.srcRotation || 0) + (entry.rotation || 0)) % 360 + 360) % 360;
  }

  function isPdfFile(file) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  }

  function isImageFile(file) {
    return /^image\/(png|jpeg|jpg)$/i.test(file.type) || /\.(png|jpe?g)$/i.test(file.name);
  }

  function isTextLike(file) {
    return (
      /^text\//i.test(file.type) ||
      /\.(txt|html|htm|md|csv)$/i.test(file.name) ||
      /\.docx$/i.test(file.name)
    );
  }

  async function fileToPlainText(file) {
    const buffer = await file.arrayBuffer();
    if (/\.docx$/i.test(file.name)) {
      const xml = new TextDecoder("utf-8").decode(buffer);
      return xml
        .replace(/<w:p[^>]*>/g, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+\n/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim() || "Converted from DOCX";
    }
    return new TextDecoder("utf-8").decode(buffer);
  }

  async function textToPdfBytes(file) {
    const raw = await fileToPlainText(file);
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const pageSize = [595, 842];
    const margin = 48;
    const size = 12;
    const lineHeight = 16;
    const maxWidth = pageSize[0] - margin * 2;
    const words = raw.replace(/\r\n/g, "\n").split(/(\s+)/);
    const lines = [];
    let current = "";
    words.forEach((word) => {
      const next = current + word;
      if (font.widthOfTextAtSize(next.replace(/\n/g, " "), size) > maxWidth) {
        if (current) lines.push(current);
        current = word.trimStart();
      } else if (word.includes("\n")) {
        const parts = (current + word).split("\n");
        parts.slice(0, -1).forEach((p) => lines.push(p));
        current = parts[parts.length - 1];
      } else {
        current = next;
      }
    });
    if (current) lines.push(current);

    let page = doc.addPage(pageSize);
    let y = pageSize[1] - margin;
    lines.forEach((line) => {
      if (y < margin) {
        page = doc.addPage(pageSize);
        y = pageSize[1] - margin;
      }
      page.drawText(line.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?"), {
        x: margin,
        y: y,
        size: size,
        font: font,
        color: PDFLib.rgb(0.1, 0.15, 0.2),
      });
      y -= lineHeight;
    });
    return await doc.save();
  }

  /* ================= modal ================= */

  function openModal(title, buildBody, buildFoot) {
    el.modalTitle.textContent = title;
    el.modalBody.innerHTML = "";
    el.modalFoot.innerHTML = "";
    if (buildBody) buildBody(el.modalBody);
    if (buildFoot) buildFoot(el.modalFoot);
    el.modal.hidden = false;
  }

  function closeModal() {
    el.modal.hidden = true;
    el.modalBody.innerHTML = "";
    el.modalFoot.innerHTML = "";
  }

  function field(labelText, input) {
    const wrap = document.createElement("label");
    wrap.className = "ws-field";
    const span = document.createElement("span");
    span.textContent = labelText;
    wrap.append(span, input);
    return wrap;
  }

  function modalButton(text, kind, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-btn " + (kind === "primary" ? "ws-btn-primary" : "ws-btn-ghost");
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  }

  /* ================= history ================= */

  function snapshot() {
    return JSON.stringify(
      state.pages.map((p) => ({
        fileId: p.fileId,
        sourceIndex: p.sourceIndex,
        srcRotation: p.srcRotation,
        rotation: p.rotation,
        annotations: p.annotations,
      }))
    );
  }

  function pushHistory() {
    state.history.push(snapshot());
    if (state.history.length > 60) state.history.shift();
    state.future.length = 0;
    updateHistoryButtons();
  }

  function restore(snap) {
    const data = JSON.parse(snap);
    state.pages = data;
    state.selected.clear();
    rerender("all");
  }

  function undo() {
    if (state.history.length < 2) {
      toast("Nothing to undo");
      return;
    }
    const current = state.history.pop();
    state.future.push(current);
    restore(state.history[state.history.length - 1]);
    updateHistoryButtons();
  }

  function redo() {
    if (!state.future.length) {
      toast("Nothing to redo");
      return;
    }
    const snap = state.future.pop();
    state.history.push(snap);
    restore(snap);
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    document.getElementById("undoBtn").disabled = state.history.length < 2;
    document.getElementById("redoBtn").disabled = state.future.length === 0;
  }

  /* ================= file loading ================= */

  async function imageToPdfBytes(file) {
    const dataUrl = await readAsDataURL(file);
    const bytes = bytesFromDataUrl(dataUrl);
    const doc = await PDFLib.PDFDocument.create();
    let img;
    if (/png$/i.test(file.type)) {
      img = await doc.embedPng(bytes);
    } else {
      try {
        img = await doc.embedJpg(bytes);
      } catch (e) {
        img = await doc.embedPng(bytes);
      }
    }
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    return await doc.save();
  }

  async function loadSource(file) {
    let bytes;
    let name = file.name;
    let size = file.size;

    if (isPdfFile(file)) {
      bytes = new Uint8Array(await file.arrayBuffer());
    } else if (isImageFile(file)) {
      const pdfBytes = await imageToPdfBytes(file);
      bytes = pdfBytes;
      size = pdfBytes.length;
    } else if (isTextLike(file)) {
      const pdfBytes = await textToPdfBytes(file);
      bytes = pdfBytes;
      size = pdfBytes.length;
    } else {
      throw new Error("Unsupported file type");
    }

    const copyForLib = bytes.slice(0);
    const pdfJsDoc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const libDoc = await PDFLib.PDFDocument.load(copyForLib, { ignoreEncryption: true });

    const fileId = state.sources.length;
    state.sources.push({ name, size, pdf: pdfJsDoc, lib: libDoc });

    for (let i = 0; i < pdfJsDoc.numPages; i++) {
      const pj = await pdfJsDoc.getPage(i + 1);
      const srcRotation = ((((pj.rotate || 0) % 360) + 360) % 360);
      state.pages.push({
        fileId,
        sourceIndex: i,
        srcRotation,
        rotation: 0,
        annotations: [],
      });
    }
    return fileId;
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList);
    const usable = files.filter((f) => isPdfFile(f) || isImageFile(f) || isTextLike(f));
    if (!usable.length) {
      toast("Only PDF, image, or text files are supported", true);
      return 0;
    }
    let added = 0;
    for (const file of usable) {
      try {
        await loadSource(file);
        added++;
      } catch (err) {
        console.error(err);
        toast("Could not open " + file.name, true);
      }
    }
    return added;
  }

  /* ================= viewport helpers ================= */

  async function pageViewport(entry, scale) {
    const src = state.sources[entry.fileId];
    const pj = await src.pdf.getPage(entry.sourceIndex + 1);
    return pj.getViewport({ scale: scale, rotation: totalRotation(entry) });
  }

  /* ================= rendering ================= */

  function annotationElement(a, viewport, scale) {
    const node = document.createElement("div");
    node.className = "ws-anno ws-anno-" + a.type;
    node.dataset.annoId = a.id;

    const px = a.nx * viewport.width;
    const py = a.ny * viewport.height;

    if (a.type === "text") {
      const span = document.createElement("span");
      span.textContent = a.text;
      span.style.fontSize = a.sizeN * viewport.width + "px";
      span.style.color = a.color;
      node.style.left = px + "px";
      node.style.top = py + "px";
      node.appendChild(span);
    } else {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.draggable = false;
      img.style.width = a.wN * viewport.width + "px";
      img.style.height = a.hN * viewport.height + "px";
      node.style.left = px + "px";
      node.style.top = py + "px";
      node.appendChild(img);
    }
    return node;
  }

  async function renderAnnotationLayer(entry, pageNode) {
    const layer = pageNode.querySelector(".ws-anno-layer");
    if (!layer) return;
    layer.innerHTML = "";
    if (!entry.annotations.length) return;
    const viewport = await pageViewport(entry, BASE_SCALE * state.zoom);
    entry.annotations.forEach((a) => {
      layer.appendChild(annotationElement(a, viewport, BASE_SCALE * state.zoom));
    });
  }

  async function renderPageCanvas(entry, scale) {
    const src = state.sources[entry.fileId];
    const pj = await src.pdf.getPage(entry.sourceIndex + 1);
    const viewport = pj.getViewport({ scale: scale, rotation: totalRotation(entry) });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await pj.render({ canvasContext: ctx, viewport: viewport }).promise;
    return canvas;
  }

  async function renderThumb(index, container) {
    const entry = state.pages[index];
    try {
      const canvas = await renderPageCanvas(entry, 0.22);
      canvas.style.width = "100%";
      canvas.style.height = "auto";
      container.innerHTML = "";
      container.appendChild(canvas);
      const num = document.createElement("span");
      num.className = "ws-thumb-num";
      num.textContent = String(index + 1);
      container.appendChild(num);
      const rot = totalRotation(entry);
      if (rot) {
        const badge = document.createElement("span");
        badge.className = "ws-thumb-rot";
        badge.textContent = rot + "\u00b0";
        container.appendChild(badge);
      }
      if (entry.annotations.length) {
        const badge = document.createElement("span");
        badge.className = "ws-thumb-anno";
        badge.textContent = entry.annotations.length;
        container.appendChild(badge);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function renderThumbs() {
    el.thumbs.innerHTML = "";
    for (let i = 0; i < state.pages.length; i++) {
      const thumb = document.createElement("div");
      thumb.className = "ws-thumb";
      thumb.dataset.index = String(i);
      thumb.addEventListener("click", (e) => selectPage(i, e.shiftKey || e.metaKey || e.ctrlKey));
      el.thumbs.appendChild(thumb);
      renderThumb(i, thumb);
    }
  }

  function isPageCardTool() {
    return ["merge", "split", "rotate", "compress"].indexOf(state.selectedTool) !== -1;
  }

  async function renderPageCards() {
    el.pageStack.classList.add("is-cards");
    for (let i = 0; i < state.pages.length; i++) {
      const entry = state.pages[i];
      const wrap = document.createElement("div");
      wrap.className = "ws-page ws-page-card";
      wrap.dataset.index = String(i);

      const canvas = await renderPageCanvas(entry, 0.36);
      canvas.style.width = "100%";
      canvas.style.height = "auto";
      wrap.appendChild(canvas);

      const badge = document.createElement("span");
      badge.className = "ws-page-badge";
      badge.textContent = "Page " + (i + 1);
      wrap.appendChild(badge);

      wrap.addEventListener("click", (e) => {
        selectPage(i, e.shiftKey || e.metaKey || e.ctrlKey);
      });

      el.pageStack.appendChild(wrap);
    }
    applySelectionClasses();
  }

  async function renderStack() {
    el.pageStack.innerHTML = "";
    el.pageStack.classList.remove("is-cards");
    if (!state.pages.length) {
      renderEmptyState();
      return;
    }
    if (isPageCardTool()) {
      await renderPageCards();
      return;
    }
    const scale = BASE_SCALE * state.zoom;
    for (let i = 0; i < state.pages.length; i++) {
      const entry = state.pages[i];
      const wrap = document.createElement("div");
      wrap.className = "ws-page";
      wrap.dataset.index = String(i);
      wrap.style.position = "relative";

      const canvas = await renderPageCanvas(entry, scale);
      wrap.appendChild(canvas);

      const layer = document.createElement("div");
      layer.className = "ws-anno-layer";
      layer.style.position = "absolute";
      layer.style.left = "0";
      layer.style.top = "0";
      layer.style.width = canvas.width + "px";
      layer.style.height = canvas.height + "px";
      layer.addEventListener("click", (e) => handlePageClick(e, i, wrap));
      wrap.appendChild(layer);

      const badge = document.createElement("span");
      badge.className = "ws-page-badge";
      badge.textContent = "Page " + (i + 1);
      wrap.appendChild(badge);

      wrap.addEventListener("click", (e) => {
        if (state.tool !== "select") return;
        if (e.target.closest(".ws-anno")) return;
        selectPage(i, e.shiftKey || e.metaKey || e.ctrlKey);
      });

      el.pageStack.appendChild(wrap);
      await renderAnnotationLayer(entry, wrap);
    }
    applySelectionClasses();
  }

  function renderEmptyState() {
    const empty = document.createElement("div");
    empty.className = "ws-empty";
    empty.innerHTML =
      '<div class="ws-empty-art">' +
      '<svg viewBox="0 0 120 120"><path d="M30 16h40l16 16v62a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6V22a6 6 0 0 1 6-6z" fill="#fff" stroke="#cfe6f4" stroke-width="3"/><path d="M70 16v16h16" fill="#e3f2fb"/><rect x="34" y="48" width="34" height="4" rx="2" fill="#d5e8f4"/><rect x="34" y="59" width="26" height="4" rx="2" fill="#d5e8f4"/><path d="M96 40l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#ffd166"/></svg>' +
      "</div>" +
      "<h3>Your workspace is empty</h3>" +
      "<p>Add a PDF or image file to start editing.</p>";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-btn ws-btn-primary";
    btn.style.margin = "0 auto";
    btn.textContent = "Choose file";
    btn.addEventListener("click", () => el.fileInput.click());
    empty.appendChild(btn);
    el.pageStack.appendChild(empty);
  }

  async function rerender(pageRefs) {
    if (pageRefs === "all" || !pageRefs) {
      await renderThumbs();
      await renderStack();
    } else {
      const indices = new Set(pageRefs);
      const thumbs = el.thumbs.querySelectorAll(".ws-thumb");
      thumbs.forEach((t, i) => {
        if (indices.has(i) && state.pages[i]) renderThumb(i, t);
      });
      await renderStack();
    }
    updateMeta();
    updateSelectionInfo();
  }

  /* ================= selection ================= */

  function applySelectionClasses() {
    document.querySelectorAll(".ws-page").forEach((n) =>
      n.classList.toggle("is-selected", state.selected.has(Number(n.dataset.index)))
    );
    document.querySelectorAll(".ws-thumb").forEach((n) =>
      n.classList.toggle("is-selected", state.selected.has(Number(n.dataset.index)))
    );
  }

  function selectPage(index, additive) {
    if (!additive) state.selected.clear();
    if (state.selected.has(index)) {
      if (additive) state.selected.delete(index);
    } else {
      state.selected.add(index);
    }
    state.current = index;
    el.pageNumber.value = String(index + 1);
    applySelectionClasses();
    updateSelectionInfo();
    updateMeta();
  }

  function updateSelectionInfo() {
    const n = state.selected.size;
    el.selectionInfo.textContent = n
      ? n + " page" + (n > 1 ? "s" : "") + " selected"
      : "No page selected";
  }

  function selectedIndices() {
    return [...state.selected].sort((a, b) => a - b);
  }

  function requireSelection() {
    if (!state.selected.size) {
      toast("Select at least one page first", true);
      return false;
    }
    return true;
  }

  /* ================= meta ================= */

  function updateMeta() {
    const sourcesSize = state.sources.reduce((s, f) => s + f.size, 0);
    el.fileMeta.textContent = state.pages.length + " pages - " + formatSize(sourcesSize);
    el.pageTotal.textContent = state.pages.length;
    el.infoPages.textContent = state.pages.length;
    el.infoSize.textContent = formatSize(sourcesSize);
    const annots = state.pages.reduce((s, p) => s + p.annotations.length, 0);
    el.infoAnnots.textContent = annots;
    const sel = selectedIndices();
    el.infoRotation.textContent =
      (sel.length ? totalRotation(state.pages[sel[0]]) : 0) + " deg";

    el.wsFileList.innerHTML = "";
    state.sources.forEach((f) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "ws-file-name";
      name.textContent = f.name;
      const size = document.createElement("span");
      size.className = "ws-file-size";
      size.textContent = formatSize(f.size);
      li.append(name, size);
      el.wsFileList.appendChild(li);
    });
  }

  /* ================= annotations ================= */

  let annoSeq = 1;

  async function handlePageClick(e, index, wrap) {
    const entry = state.pages[index];
    const layer = wrap.querySelector(".ws-anno-layer");

    if (state.tool === "select") return;
    e.stopPropagation();

    if (state.tool === "erase") {
      const target = e.target.closest(".ws-anno");
      if (!target) return;
      const id = target.dataset.annoId;
      pushHistory();
      entry.annotations = entry.annotations.filter((a) => String(a.id) !== String(id));
      target.remove();
      await renderThumb(index, el.thumbs.querySelectorAll(".ws-thumb")[index]);
      updateMeta();
      markSaved();
      toast("Annotation removed");
      return;
    }

    if (state.tool === "text") {
      const rect = layer.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      askText((text, size, color) => {
        pushHistory();
        entry.annotations.push({
          id: annoSeq++,
          type: "text",
          nx,
          ny,
          text,
          sizeN: size / 100,
          color,
        });
        renderAnnotationLayer(entry, wrap).then(() => {
          renderThumb(index, el.thumbs.querySelectorAll(".ws-thumb")[index]);
          updateMeta();
          markSaved();
        });
      });
      return;
    }

    if (state.tool === "image" && state.pendingImage) {
      const rect = layer.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      const p = state.pendingImage;
      pushHistory();
      entry.annotations.push({
        id: annoSeq++,
        type: "image",
        nx,
        ny,
        wN: p.wN,
        hN: p.hN,
        dataUrl: p.dataUrl,
      });
      state.pendingImage = null;
      setTool("select");
      await renderAnnotationLayer(entry, wrap);
      await renderThumb(index, el.thumbs.querySelectorAll(".ws-thumb")[index]);
      updateMeta();
      markSaved();
      toast("Image placed");
      return;
    }

    if (state.tool === "sign" && state.pendingSignature) {
      const rect = layer.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top) / rect.height;
      const sig = state.pendingSignature;
      pushHistory();
      entry.annotations.push({
        id: annoSeq++,
        type: "sign",
        nx,
        ny,
        wN: 0.34,
        hN: 0.34 * (sig.height / sig.width) * (rect.width / rect.height),
        dataUrl: sig.dataUrl,
      });
      state.pendingSignature = null;
      setTool("select");
      await renderAnnotationLayer(entry, wrap);
      await renderThumb(index, el.thumbs.querySelectorAll(".ws-thumb")[index]);
      updateMeta();
      markSaved();
      toast("Signature placed");
    }
  }

  function askText(callback) {
    const textarea = document.createElement("textarea");
    textarea.className = "ws-input";
    textarea.rows = 3;
    textarea.placeholder = "Type your text";
    textarea.value = "Your text here";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = "#16323f";
    colorInput.className = "ws-color";

    const sizeInput = document.createElement("input");
    sizeInput.type = "range";
    sizeInput.min = "2";
    sizeInput.max = "14";
    sizeInput.step = "0.5";
    sizeInput.value = "5";
    sizeInput.className = "ws-range";

    openModal(
      "Add text",
      (body) => {
        body.appendChild(textarea);
        body.appendChild(field("Font size", sizeInput));
        body.appendChild(field("Colour", colorInput));
      },
      (foot) => {
        foot.appendChild(
          modalButton("Cancel", "ghost", closeModal)
        );
        foot.appendChild(
          modalButton("Add text", "primary", () => {
            const value = textarea.value.trim();
            if (!value) {
              toast("Enter some text", true);
              return;
            }
            closeModal();
            callback(value, parseFloat(sizeInput.value), colorInput.value);
          })
        );
      }
    );
    textarea.focus();
  }

  async function pickImage() {
    el.imageInput.click();
  }

  el.imageInput.addEventListener("change", async () => {
    const file = el.imageInput.files[0];
    el.imageInput.value = "";
    if (!file) return;
    const dataUrl = await readAsDataURL(file);
    const img = new Image();
    img.onload = () => {
      state.pendingImage = {
        dataUrl,
        wN: 0.32,
        hN: 0.32 * (img.height / img.width),
      };
      toast("Click on a page to place the image");
      status("Click a page to place the image");
    };
    img.onerror = () => toast("Could not read that image", true);
    img.src = dataUrl;
  });

  function openSignaturePad() {
    const canvas = document.createElement("canvas");
    canvas.className = "ws-sig-pad";
    canvas.width = 560;
    canvas.height = 220;

    openModal(
      "Draw your signature",
      (body) => {
        body.appendChild(canvas);
        const hint = document.createElement("p");
        hint.className = "ws-note";
        hint.textContent = "Draw with your mouse or finger, then press Use signature.";
        body.appendChild(hint);
      },
      (foot) => {
        foot.appendChild(
          modalButton("Clear", "ghost", () => {
            const ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          })
        );
        foot.appendChild(
          modalButton("Use signature", "primary", () => {
            const ctx = canvas.getContext("2d");
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let hasInk = false;
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] > 0) {
                hasInk = true;
                break;
              }
            }
            if (!hasInk) {
              toast("Draw a signature first", true);
              return;
            }
            state.pendingSignature = {
              dataUrl: canvas.toDataURL("image/png"),
              width: canvas.width,
              height: canvas.height,
            };
            closeModal();
            toast("Click on a page to place the signature");
            status("Click a page to place the signature");
          })
        );
      }
    );

    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#122b3a";

    let drawing = false;
    let last = null;

    function pos(e) {
      const rect = canvas.getBoundingClientRect();
      const point = e.touches ? e.touches[0] : e;
      return [
        (point.clientX - rect.left) * (canvas.width / rect.width),
        (point.clientY - rect.top) * (canvas.height / rect.height),
      ];
    }

    function start(e) {
      drawing = true;
      last = pos(e);
      e.preventDefault();
    }
    function move(e) {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      last = p;
      e.preventDefault();
    }
    function end() {
      drawing = false;
      last = null;
    }

    canvas.addEventListener("mousedown", start);
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    canvas.addEventListener("touchstart", start, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", end);
  }

  /* ================= export ================= */

  function colorToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return PDFLib.rgb(0, 0, 0);
    return PDFLib.rgb(
      parseInt(m[1], 16) / 255,
      parseInt(m[2], 16) / 255,
      parseInt(m[3], 16) / 255
    );
  }

  async function buildPdf(indices, progress) {
    const out = await PDFLib.PDFDocument.create();
    const libCache = new Map();
    const fontCache = new Map();
    const imageCache = new Map();

    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const entry = state.pages[i];
      if (!entry) continue;
      if (progress) progress(k + 1, indices.length);

      const src = state.sources[entry.fileId];
      let libDoc = libCache.get(entry.fileId);
      if (!libDoc) {
        libDoc = src.lib;
        libCache.set(entry.fileId, libDoc);
      }

      const [copied] = await out.copyPages(libDoc, [entry.sourceIndex]);
      const rot = totalRotation(entry);
      if (rot) copied.setRotation(PDFLib.degrees(rot));

      if (entry.annotations.length) {
        const viewport = await pageViewport(entry, 1);
        for (const a of entry.annotations) {
          const px = a.nx * viewport.width;
          const pyTop = a.ny * viewport.height;
          const pdfPoint = viewport.convertToPdfPoint(px, pyTop);

          if (a.type === "text") {
            let font = fontCache.get("helv");
            if (!font) {
              font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
              fontCache.set("helv", font);
            }
            copied.drawText(a.text, {
              x: pdfPoint[0],
              y: pdfPoint[1],
              size: a.sizeN * viewport.width,
              font: font,
              color: colorToRgb(a.color),
              rotate: PDFLib.degrees(rot),
            });
          } else {
            let img = imageCache.get(a.dataUrl);
            if (!img) {
              const bytes = bytesFromDataUrl(a.dataUrl);
              if (/^data:image\/jpe?g/i.test(a.dataUrl)) {
                img = await out.embedJpg(bytes);
              } else {
                img = await out.embedPng(bytes);
              }
              imageCache.set(a.dataUrl, img);
            }
            const w = a.wN * viewport.width;
            const h = a.hN * viewport.height;
            copied.drawImage(img, {
              x: pdfPoint[0],
              y: pdfPoint[1] - h,
              width: w,
              height: h,
              rotate: PDFLib.degrees(rot),
            });
          }
        }
      }
      out.addPage(copied);
    }
    return out;
  }

  async function withProgress(label, task) {
    const wrap = document.createElement("div");
    wrap.className = "ws-progress";
    const bar = document.createElement("div");
    bar.className = "ws-progress-bar";
    const fill = document.createElement("span");
    bar.appendChild(fill);
    const text = document.createElement("div");
    text.className = "ws-note";
    text.textContent = label;
    wrap.append(text, bar);
    el.modalBody.innerHTML = "";
    el.modalFoot.innerHTML = "";
    el.modalTitle.textContent = "Working";
    el.modalBody.appendChild(wrap);
    el.modal.hidden = false;
    const setPct = (p) => (fill.style.width = Math.round(p * 100) + "%");
    setPct(0.05);
    try {
      const result = await task(setPct);
      closeModal();
      return result;
    } catch (err) {
      closeModal();
      throw err;
    }
  }

  async function exportPdf(opts) {
    if (!state.pages.length) {
      toast("Nothing to export yet", true);
      return;
    }
    const options = opts || {};
    const out = await withProgress("Building PDF...", (setPct) =>
      buildPdf(
        state.pages.map((_, i) => i),
        (done, total) => setPct(done / total)
      )
    );
    const saveOpts = { useObjectStreams: true };
    const bytes = await out.save(saveOpts);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const name = baseName(el.fileName.value) + (options.suffix || "") + ".pdf";
    download(blob, name);
    status("Exported " + name);
    toast("Downloaded " + name);

    if (options.reportSize && options.originalSize) {
      const diff = options.originalSize - blob.size;
      if (diff > 0) {
        toast("Reduced by " + formatSize(diff));
      } else {
        toast("This PDF is already well optimized");
      }
    }
    return blob;
  }

  async function extractSelection() {
    if (!requireSelection()) return;
    const indices = selectedIndices();
    const out = await withProgress("Extracting pages...", (setPct) =>
      buildPdf(indices, (d, t) => setPct(d / t))
    );
    const bytes = await out.save();
    download(
      new Blob([bytes], { type: "application/pdf" }),
      baseName(el.fileName.value) + "-extracted.pdf"
    );
    toast("Extracted " + indices.length + " page(s)");
    status("Extracted " + indices.length + " page(s)");
  }

  async function splitAfterSelection() {
    if (!requireSelection()) return;
    const cut = Math.max(...selectedIndices());
    const all = state.pages.map((_, i) => i);
    const base = baseName(el.fileName.value);
    const first = await withProgress("Splitting document...", (setPct) =>
      buildPdf(all.slice(0, cut + 1), (d, t) => setPct(d / t))
    );
    download(new Blob([await first.save()], { type: "application/pdf" }), base + "-part-1.pdf");
    await new Promise((r) => setTimeout(r, 350));
    if (all.length > cut + 1) {
      const second = await buildPdf(all.slice(cut + 1));
      download(new Blob([await second.save()], { type: "application/pdf" }), base + "-part-2.pdf");
    }
    toast("Split after page " + (cut + 1));
    status("Split after page " + (cut + 1));
  }

  function totalSourceSize() {
    return state.sources.reduce((s, f) => s + f.size, 0);
  }

  /* ================= tools ================= */

  function openProtectModal() {
    if (!state.pages.length) {
      toast("Add a file first", true);
      return;
    }
    const userPass = document.createElement("input");
    userPass.type = "password";
    userPass.className = "ws-input";
    userPass.placeholder = "Open password";

    const ownerPass = document.createElement("input");
    ownerPass.type = "password";
    ownerPass.className = "ws-input";
    ownerPass.placeholder = "Owner password (optional)";

    const confirmPass = document.createElement("input");
    confirmPass.type = "password";
    confirmPass.className = "ws-input";
    confirmPass.placeholder = "Repeat open password";

    const printing = document.createElement("input");
    printing.type = "checkbox";
    printing.checked = true;
    const copying = document.createElement("input");
    copying.type = "checkbox";
    const modifying = document.createElement("input");
    modifying.type = "checkbox";

    function check(labelText, input, checked) {
      input.checked = !!checked;
      const label = document.createElement("label");
      label.className = "ws-check";
      label.append(input, document.createTextNode(labelText));
      return label;
    }

    openModal(
      "Protect PDF",
      (body) => {
        body.appendChild(field("Open password", userPass));
        body.appendChild(field("Confirm password", confirmPass));
        body.appendChild(field("Owner password (optional)", ownerPass));
        body.appendChild(check("Allow printing", printing, true));
        body.appendChild(check("Allow copying text", copying, false));
        body.appendChild(check("Allow editing", modifying, false));
        const note = document.createElement("p");
        note.className = "ws-note";
        note.textContent = "Encryption uses AES-256 and runs fully in your browser.";
        body.appendChild(note);
      },
      (foot) => {
        foot.appendChild(modalButton("Cancel", "ghost", closeModal));
        foot.appendChild(
          modalButton("Encrypt & download", "primary", async () => {
            if (!userPass.value) {
              toast("Enter an open password", true);
              return;
            }
            if (userPass.value !== confirmPass.value) {
              toast("Passwords do not match", true);
              return;
            }
            closeModal();
            try {
              const out = await withProgress("Encrypting PDF...", (setPct) =>
                buildPdf(state.pages.map((_, i) => i), (d, t) => setPct(d / t))
              );
              out.encrypt({
                userPassword: userPass.value,
                ownerPassword: ownerPass.value || userPass.value,
                permissions: {
                  printing: printing.checked ? "highResolution" : undefined,
                  copying: copying.checked,
                  modifying: modifying.checked,
                  annotating: true,
                  fillingForms: true,
                  contentAccessibility: true,
                  documentAssembly: false,
                },
              });
              const bytes = await out.save();
              download(
                new Blob([bytes], { type: "application/pdf" }),
                baseName(el.fileName.value) + "-protected.pdf"
              );
              toast("Protected PDF downloaded");
              status("Protected with password");
            } catch (err) {
              console.error(err);
              toast("Could not encrypt: " + err.message, true);
            }
          })
        );
      }
    );
    userPass.focus();
  }

  function openConvertImagesModal() {
    if (!state.pages.length) {
      toast("Add a file first", true);
      return;
    }
    const format = document.createElement("select");
    format.className = "ws-input";
    ["PNG", "JPG"].forEach((f) => {
      const o = document.createElement("option");
      o.value = f;
      o.textContent = f;
      format.appendChild(o);
    });

    const quality = document.createElement("input");
    quality.type = "range";
    quality.min = "0.5";
    quality.max = "1";
    quality.step = "0.05";
    quality.value = "0.92";
    quality.className = "ws-range";

    const scaleSel = document.createElement("select");
    scaleSel.className = "ws-input";
    [["1", "Standard (1x)"], ["2", "High (2x)"], ["3", "Very high (3x)"]].forEach(([v, l]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      scaleSel.appendChild(o);
    });
    scaleSel.value = "2";

    openModal(
      "PDF to images",
      (body) => {
        body.appendChild(field("Format", format));
        body.appendChild(field("Resolution", scaleSel));
        body.appendChild(field("JPG quality", quality));
        const note = document.createElement("p");
        note.className = "ws-note";
        note.textContent = "Each page is exported as a separate image file.";
        body.appendChild(note);
      },
      (foot) => {
        foot.appendChild(modalButton("Cancel", "ghost", closeModal));
        foot.appendChild(
          modalButton("Convert", "primary", async () => {
            const fmt = format.value;
            const scale = parseFloat(scaleSel.value);
            closeModal();
            await runImageConversion(fmt, scale, parseFloat(quality.value));
          })
        );
      }
    );
  }

  async function runImageConversion(fmt, scale, quality) {
    const base = baseName(el.fileName.value);
    const mime = fmt === "PNG" ? "image/png" : "image/jpeg";
    const ext = fmt === "PNG" ? ".png" : ".jpg";

    openModal("Converting PDF to images", (body) => {
      const p = document.createElement("p");
      p.className = "ws-note";
      p.id = "convStatus";
      p.textContent = "Preparing...";
      body.appendChild(p);
    });

    try {
      for (let i = 0; i < state.pages.length; i++) {
        const entry = state.pages[i];
        const src = state.sources[entry.fileId];
        const pj = await src.pdf.getPage(entry.sourceIndex + 1);
        const viewport = pj.getViewport({ scale: scale, rotation: totalRotation(entry) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        if (fmt === "JPG") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        await pj.render({ canvasContext: ctx, viewport: viewport }).promise;

        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, mime, fmt === "JPG" ? quality : undefined)
        );
        download(blob, base + "-page-" + (i + 1) + ext);

        const statusEl = document.getElementById("convStatus");
        if (statusEl) statusEl.textContent = "Page " + (i + 1) + " of " + state.pages.length;
        await new Promise((r) => setTimeout(r, 320));
      }
      closeModal();
      toast("Converted " + state.pages.length + " page(s) to " + fmt);
      status("Converted " + state.pages.length + " page(s) to " + fmt);
    } catch (err) {
      console.error(err);
      closeModal();
      toast("Conversion failed: " + err.message, true);
    }
  }

  function openImagesToPdf() {
    el.fileInput.click();
  }

  async function exportPdfAsText() {
    if (!state.pages.length) {
      toast("Add a file first", true);
      return;
    }
    const chunks = [];
    for (let i = 0; i < state.pages.length; i++) {
      const entry = state.pages[i];
      const src = state.sources[entry.fileId];
      const pj = await src.pdf.getPage(entry.sourceIndex + 1);
      const content = await pj.getTextContent();
      const text = content.items.map((item) => item.str).join(" ");
      chunks.push("Page " + (i + 1) + "\n" + text + "\n");
    }
    const blob = new Blob([chunks.join("\n")], { type: "text/plain" });
    download(blob, baseName(el.fileName.value) + ".txt");
    toast("Downloaded as text (Word-compatible)");
    status("Exported text document");
  }

  async function compressAndDownload() {
    if (!state.pages.length) {
      toast("Add a file first", true);
      return;
    }
    const original = totalSourceSize();
    const out = await withProgress("Compressing PDF...", (setPct) =>
      buildPdf(state.pages.map((_, i) => i), (d, t) => setPct(d / t))
    );
    const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
    const blob = new Blob([bytes], { type: "application/pdf" });
    download(blob, baseName(el.fileName.value) + "-compressed.pdf");
    const diff = original - blob.size;
    if (diff > 0) {
      toast("Compressed - saved " + formatSize(diff));
      status("Compressed: " + formatSize(original) + " to " + formatSize(blob.size));
    } else {
      toast("Already optimized (" + formatSize(blob.size) + ")");
      status("Compressed output " + formatSize(blob.size));
    }
  }

  /* ================= page edits ================= */

  function rotateSelection(delta) {
    if (!requireSelection()) return;
    pushHistory();
    selectedIndices().forEach((i) => {
      state.pages[i].rotation = (state.pages[i].rotation + delta + 360) % 360;
    });
    rerender("all");
    toast("Rotated " + state.selected.size + " page(s)");
    markSaved();
  }

  function moveSelection(direction) {
    if (!requireSelection()) return;
    pushHistory();
    const indices = selectedIndices();
    const order = direction < 0 ? indices : indices.slice().reverse();
    order.forEach((i) => {
      const target = i + direction;
      if (target < 0 || target >= state.pages.length) return;
      const tmp = state.pages[i];
      state.pages[i] = state.pages[target];
      state.pages[target] = tmp;
    });
    state.selected = new Set(
      indices.map((i) => i + direction).filter((i) => i >= 0 && i < state.pages.length)
    );
    rerender("all");
    markSaved();
  }

  function deleteSelection() {
    if (!requireSelection()) return;
    pushHistory();
    const indices = selectedIndices();
    state.pages = state.pages.filter((_, i) => !indices.includes(i));
    state.selected.clear();
    if (state.current >= state.pages.length) state.current = Math.max(0, state.pages.length - 1);
    rerender("all");
    toast("Deleted " + indices.length + " page(s)");
    markSaved();
  }

  function zoomBy(delta) {
    state.zoom = Math.min(2.4, Math.max(0.4, +(state.zoom + delta).toFixed(2)));
    el.zoomLabel.textContent = Math.round(state.zoom * 100) + "%";
    renderStack();
    markSaved();
  }

  function scrollToPage(index) {
    const node = el.pageStack.querySelector('.ws-page[data-index="' + index + '"]');
    if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function setTool(mode, silent) {
    state.tool = mode;
    document.querySelectorAll(".ws-chip").forEach((c) => {
      c.classList.toggle("is-active", c.dataset.mode === mode);
    });
    const names = { select: "Select", text: "Text", image: "Image", sign: "Sign", erase: "Erase" };
    el.statusMode.textContent = (names[mode] || "Select") + " mode";
    status(names[mode] + " tool active");

    if (silent) return;
    if (mode === "image") pickImage();
    if (mode === "sign") openSignaturePad();
  }

  const WORKSPACES = {
    edit: { title: "Edit PDF", hint: "Add or overlay text on pages.", chips: ["text", "erase"], page: [], file: ["edit", "info", "files"], tab: "file", mode: "text" },
    annotate: { title: "Annotate PDF", hint: "Mark up pages with text overlays.", chips: ["text", "erase"], page: [], file: ["edit", "info", "files"], tab: "file", mode: "text" },
    watermark: { title: "Watermark PDF", hint: "Stamp text or an image on the page.", chips: ["text", "image", "erase"], page: [], file: ["watermark", "info", "files"], tab: "file", mode: "text" },
    image: { title: "Add Images", hint: "Place photos or graphics onto the PDF.", chips: ["image", "erase"], page: [], file: ["image", "info", "files"], tab: "file", mode: "image" },
    sign: { title: "Sign Document", hint: "Draw a signature and place it on a page.", chips: ["sign", "erase"], page: [], file: ["sign", "info", "files"], tab: "file", mode: "sign" },
    "request-sign": { title: "Request Signature", hint: "Add a signature box, then download and share.", chips: ["sign", "erase"], page: [], file: ["sign", "info", "files"], tab: "file", mode: "sign" },
    rotate: { title: "Rotate PDF", hint: "Rotate selected pages left or right.", chips: [], page: ["rotate"], file: ["info", "files"], tab: "page" },
    split: { title: "Split PDF", hint: "Split the document after the selected page.", chips: [], page: ["split"], file: ["info", "files"], tab: "page" },
    merge: { title: "Merge PDF", hint: "Combine every page in this workspace into one PDF.", chips: [], page: ["arrange"], file: ["merge", "info", "files"], tab: "file" },
    compress: { title: "Compress PDF", hint: "Rebuild with compressed streams to reduce size.", chips: [], page: [], file: ["compress", "info", "files"], tab: "file" },
    protect: { title: "Protect PDF", hint: "Encrypt with AES-256 and set an open password.", chips: [], page: [], file: ["protect", "info", "files"], tab: "file" },
    convert: { title: "Convert PDF", hint: "Export pages as images, or turn images into a PDF.", chips: [], page: [], file: ["pdf-jpg", "jpg-pdf", "info", "files"], tab: "file" },
    "pdf-jpg": { title: "PDF to JPG", hint: "Export each page as a JPG or PNG image.", chips: [], page: [], file: ["pdf-jpg", "info", "files"], tab: "file" },
    "jpg-pdf": { title: "JPG to PDF", hint: "Turn images in this workspace into one PDF.", chips: [], page: [], file: ["jpg-pdf", "info", "files"], tab: "file" },
    "pdf-word": { title: "PDF to Word", hint: "Download a Word-friendly text document.", chips: [], page: [], file: ["info", "files"], tab: "file" },
    "word-pdf": { title: "Word to PDF", hint: "Download the converted PDF.", chips: [], page: [], file: ["info", "files"], tab: "file" },
  };

  function readStoredTool() {
    try {
      return sessionStorage.getItem("dm-selected-tool") || "";
    } catch (err) {
      return "";
    }
  }

  function storeSelectedTool(tool) {
    try {
      if (tool) sessionStorage.setItem("dm-selected-tool", tool);
    } catch (err) {}
  }

  function resolveSelectedTool(pendingTool) {
    const params = new URLSearchParams(window.location.search);
    return (pendingTool || params.get("tool") || readStoredTool() || "").trim();
  }

  function applySelectedTool(tool, silent) {
    const key = tool || "";
    state.selectedTool = key;
    storeSelectedTool(key);
    if (key) document.documentElement.setAttribute("data-tool", key);
    else document.documentElement.removeAttribute("data-tool");
    if (isPageCardTool()) document.documentElement.setAttribute("data-layout", "cards");
    else document.documentElement.removeAttribute("data-layout");

    const workspace = WORKSPACES[key];
    const titleEl = document.getElementById("workspaceTitle");
    const hintEl = document.getElementById("workspaceHint");
    const toolbar = document.getElementById("canvasToolbar");
    const chips = document.querySelectorAll(".ws-chip");
    const blocks = document.querySelectorAll(".ws-panel-block[data-scope]");
    const pageBody = document.querySelector('.ws-tab-body[data-body="page"]');
    const fileBody = document.querySelector('.ws-tab-body[data-body="file"]');

    if (titleEl) titleEl.textContent = workspace ? workspace.title : "Workspace";
    if (hintEl) hintEl.textContent = workspace ? workspace.hint : "Upload a PDF to start.";
    document.title = (workspace ? workspace.title : "Workspace") + " - Docu-Magic";

    const back = document.getElementById("wsBack");
    if (back) back.href = key ? "tool.html?id=" + encodeURIComponent(key) : "index.html";

    if (!workspace) {
      chips.forEach((c) => { c.hidden = false; });
      blocks.forEach((b) => { b.hidden = false; });
      if (pageBody) {
        pageBody.hidden = false;
        pageBody.classList.add("is-active");
      }
      if (fileBody) {
        fileBody.hidden = false;
        fileBody.classList.remove("is-active");
      }
      if (toolbar) toolbar.classList.remove("is-empty");
      setTool("select", true);
      return;
    }

    chips.forEach((c) => {
      c.hidden = workspace.chips.indexOf(c.dataset.mode) === -1;
    });
    if (toolbar) toolbar.classList.toggle("is-empty", !workspace.chips.length);

    const allowed = (workspace.page || []).concat(workspace.file || []);
    blocks.forEach((b) => {
      b.hidden = allowed.indexOf(b.dataset.scope) === -1;
    });

    const pageOn = (workspace.page || []).length > 0;
    if (pageBody) {
      pageBody.classList.toggle("is-needed", pageOn);
      pageBody.classList.toggle("is-active", pageOn);
      pageBody.hidden = !pageOn;
    }
    if (fileBody) {
      fileBody.classList.add("is-active");
      fileBody.hidden = false;
    }

    if (workspace.mode) setTool(workspace.mode, !!silent);
  }

  /* ================= bindings ================= */

  function bindTopbar() {
    document.getElementById("zoomIn").addEventListener("click", () => zoomBy(0.1));
    document.getElementById("zoomOut").addEventListener("click", () => zoomBy(-0.1));
    document.getElementById("prevPage").addEventListener("click", () => {
      const i = Math.max(0, state.current - 1);
      selectPage(i, false);
      scrollToPage(i);
    });
    document.getElementById("nextPage").addEventListener("click", () => {
      const i = Math.min(state.pages.length - 1, state.current + 1);
      selectPage(i, false);
      scrollToPage(i);
    });
    el.pageNumber.addEventListener("change", () => {
      const i = Math.min(
        state.pages.length - 1,
        Math.max(0, parseInt(el.pageNumber.value, 10) - 1 || 0)
      );
      selectPage(i, false);
      scrollToPage(i);
    });
    document.getElementById("undoBtn").addEventListener("click", undo);
    document.getElementById("redoBtn").addEventListener("click", redo);
    document.getElementById("downloadBtn").addEventListener("click", () => exportPdf());
    document.getElementById("addMoreBtn").addEventListener("click", () => el.fileInput.click());
    el.fileName.addEventListener("input", markSaved);
  }

  function bindPanel() {
    document.querySelectorAll("[data-rotate]").forEach((btn) => {
      btn.addEventListener("click", () => rotateSelection(parseInt(btn.dataset.rotate, 10)));
    });
    document.getElementById("moveUp").addEventListener("click", () => moveSelection(-1));
    document.getElementById("moveDown").addEventListener("click", () => moveSelection(1));
    document.getElementById("deleteBtn").addEventListener("click", deleteSelection);
    document.getElementById("extractBtn").addEventListener("click", extractSelection);
    document.getElementById("splitBtn").addEventListener("click", splitAfterSelection);

    document.getElementById("mergeBtn").addEventListener("click", () => exportPdf({ suffix: "-merged" }));
    document.getElementById("compressBtn").addEventListener("click", compressAndDownload);
    document.getElementById("protectBtn").addEventListener("click", openProtectModal);
    document.getElementById("convertImagesBtn").addEventListener("click", openConvertImagesModal);
    document.getElementById("convertPdfBtn").addEventListener("click", openImagesToPdf);

    const addTextBtn = document.getElementById("addTextBtn");
    if (addTextBtn) addTextBtn.addEventListener("click", () => setTool("text", true));
    const placeImageBtn = document.getElementById("placeImageBtn");
    if (placeImageBtn) placeImageBtn.addEventListener("click", () => setTool("image"));
    const placeSignBtn = document.getElementById("placeSignBtn");
    if (placeSignBtn) placeSignBtn.addEventListener("click", () => setTool("sign"));
    const placeWatermarkBtn = document.getElementById("placeWatermarkBtn");
    if (placeWatermarkBtn) placeWatermarkBtn.addEventListener("click", () => setTool("text", true));

    document.getElementById("selectAllPages").addEventListener("click", () => {
      if (!state.pages.length) return;
      state.selected = new Set(state.pages.map((_, i) => i));
      applySelectionClasses();
      updateSelectionInfo();
      updateMeta();
    });

    document.querySelectorAll(".ws-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".ws-tab").forEach((t) => t.classList.toggle("is-active", t === tab));
        document.querySelectorAll(".ws-tab-body").forEach((body) => {
          body.classList.toggle("is-active", body.dataset.body === tab.dataset.tab);
        });
      });
    });

    document.querySelectorAll(".ws-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        if (chip.hidden) return;
        setTool(chip.dataset.mode);
      });
    });

    document.getElementById("modalClose").addEventListener("click", closeModal);
    el.modal.addEventListener("click", (e) => {
      if (e.target === el.modal) closeModal();
    });
  }

  function bindUpload() {
    el.fileInput.addEventListener("change", async () => {
      const files = Array.from(el.fileInput.files);
      el.fileInput.value = "";
      const added = await addFiles(files);
      if (!added) return;
      if (state.sources.length && !state.history.length) {
        state.history.push(snapshot());
      }
      if (state.sources[0]) el.fileName.value = baseName(state.sources[0].name) + ".pdf";
      await rerender("all");
      toast("Added " + added + " file(s)");
      status("Added " + added + " file(s)");
      markSaved();
    });

    const wrap = document.querySelector(".ws-canvas-wrap");
    let depth = 0;
    wrap.addEventListener("dragenter", (e) => {
      e.preventDefault();
      depth++;
      el.dropHint.classList.add("is-visible");
    });
    wrap.addEventListener("dragover", (e) => e.preventDefault());
    wrap.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) el.dropHint.classList.remove("is-visible");
    });
    wrap.addEventListener("drop", async (e) => {
      e.preventDefault();
      depth = 0;
      el.dropHint.classList.remove("is-visible");
      const added = await addFiles(e.dataTransfer.files || []);
      if (!added) return;
      if (state.sources[0]) el.fileName.value = baseName(state.sources[0].name) + ".pdf";
      await rerender("all");
      toast("Added " + added + " file(s)");
      markSaved();
    });
  }

  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, textarea, select")) return;
      if (e.key === "Escape") closeModal();
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === "ArrowRight") {
        const i = Math.min(state.pages.length - 1, state.current + 1);
        selectPage(i, false);
        scrollToPage(i);
      } else if (e.key === "ArrowLeft") {
        const i = Math.max(0, state.current - 1);
        selectPage(i, false);
        scrollToPage(i);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    });
  }

  /* ================= pending files (from home page) ================= */

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

  function readPending() {
    return openStore()
      .then(
        (db) =>
          new Promise((resolve) => {
            const tx = db.transaction("pending", "readonly");
            const get = tx.objectStore("pending").get("current");
            get.onsuccess = () => resolve(get.result || null);
            get.onerror = () => resolve(null);
          })
      )
      .catch(() => null);
  }

  function clearPending() {
    return openStore()
      .then((db) => {
        const tx = db.transaction("pending", "readwrite");
        tx.objectStore("pending").delete("current");
      })
      .catch(() => null);
  }

  /* ================= boot ================= */

  async function boot() {
    bindTopbar();
    bindPanel();
    bindUpload();
    bindKeyboard();
    updateHistoryButtons();

    const pending = await readPending();
    const incomingTool = resolveSelectedTool(pending && pending.tool);
    applySelectedTool(incomingTool, true);
    updateMeta();
    renderStack();

    if (incomingTool && !new URLSearchParams(window.location.search).get("tool")) {
      history.replaceState(null, "", "workspace.html?tool=" + encodeURIComponent(incomingTool));
    }

    if (pending && pending.files && pending.files.length) {
      for (const entry of pending.files) {
        const file = new File([entry.data], entry.name, { type: entry.type });
        try {
          await loadSource(file);
        } catch (err) {
          console.error(err);
          toast("Could not open " + entry.name, true);
        }
      }
      if (state.pages.length) {
        state.history.push(snapshot());
        if (state.sources[0]) el.fileName.value = baseName(state.sources[0].name) + ".pdf";
        await rerender("all");
        toast("Loaded " + state.sources.length + " file(s)");
        status("Loaded " + state.pages.length + " page(s)");
      }
      clearPending();
    }
  }

  if (!pdfjsLib || !PDFLib.PDFDocument) {
    renderStack();
    toast("PDF engine failed to load", true);
  } else {
    boot();
  }
})();
