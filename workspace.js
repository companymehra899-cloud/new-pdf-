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
    zoom: 0.6,
    current: 0,
    tool: "select",
    selectedTool: "",
    pendingImage: null,
    pendingSignature: null,
    edit: { mode: "select", shape: null, bold: false, font: "Helvetica", size: 12, color: "#16323f" },
    selAnno: null,
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
    signInput: document.getElementById("wsSignInput"),
    signFloat: document.getElementById("signFloat"),
    signFloatImg: document.getElementById("signFloatImg"),
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
        cropN: p.cropN,
        editedItems: p.editedItems,
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
    state.selAnno = null;
    rerender("all");
  }

  function undo() {
    if (state.history.length < 2) {
      toast("Nothing to undo");
      return;
    }
    state.future.push(snapshot());
    const prev = state.history.pop();
    restore(prev);
    updateHistoryButtons();
  }

  function redo() {
    if (!state.future.length) {
      toast("Nothing to redo");
      return;
    }
    const next = state.future.pop();
    state.history.push(snapshot());
    restore(next);
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
    const usable = files.filter((f) => isPdfFile(f) || isImageFile(f));
    if (!usable.length) {
      toast("Only PDF or image files are supported", true);
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

  function annotationElement(a, entry, viewport, pageNode) {
    const node = document.createElement("div");
    node.className = "ws-anno ws-anno-" + a.type;
    node.dataset.annoId = a.id;

    const px = a.nx * viewport.width;
    const py = a.ny * viewport.height;

    if (a.type === "cover") {
      node.className = "ws-anno ws-anno-cover";
      node.style.left = px + "px";
      node.style.top = py + "px";
      node.style.width = a.wN * viewport.width + "px";
      node.style.height = a.hN * viewport.height + "px";
      node.style.background = a.color || "#ffffff";
      return node;
    }

    if (a.type === "shape") {
      node.className = "ws-anno ws-anno-shape";
      node.style.left = px + "px";
      node.style.top = py + "px";
      node.style.width = a.wN * viewport.width + "px";
      node.style.height = a.hN * viewport.height + "px";
      node.style.border =
        Math.max(1, a.strokeWN * viewport.width) + "px solid " + (a.color || "#e5322d");
      node.style.borderRadius = a.shape === "circle" ? "50%" : "3px";
      node.style.background = a.fill ? a.fill : "transparent";
      return node;
    }

    if (a.type === "text") {
      const span = document.createElement("span");
      span.textContent = a.text;
      span.style.fontSize = a.sizeN * viewport.width + "px";
      span.style.color = a.color;
      span.style.fontFamily = fontFamilyFromName(a.font || "Helvetica");
      span.style.fontWeight = a.bold ? "700" : "400";
      span.style.fontStyle = a.italic ? "italic" : "normal";
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
    if (a.type === "sign" || a.type === "image") enableAnnoControls(node, a, entry, pageNode);
    return node;
  }

  function removeAnnotation(entry, anno, pageNode) {
    pushHistory();
    entry.annotations = entry.annotations.filter((x) => x !== anno);
    if (state.selAnno && state.selAnno.anno === anno) state.selAnno = null;
    renderAnnotationLayer(entry, pageNode);
    updateMeta();
    markSaved();
    toast("Removed");
  }

  function enableAnnoControls(node, anno, entry, pageNode) {
    node.style.cursor = "grab";

    node.addEventListener("pointerdown", (e) => {
      if (state.tool === "erase") return;
      if (e.target.closest(".ws-anno-resize") || e.target.closest(".ws-anno-remove")) return;
      e.preventDefault();
      e.stopPropagation();
      const layer = node.parentElement;
      if (!layer) return;
      pushHistory();
      selectAnno(node, anno, entry, pageNode);
      node.style.cursor = "grabbing";
      const startX = e.clientX;
      const startY = e.clientY;
      const startNx = anno.nx;
      const startNy = anno.ny;
      const rect = layer.getBoundingClientRect();
      function move(ev) {
        anno.nx = Math.min(0.92, Math.max(0, startNx + (ev.clientX - startX) / rect.width));
        anno.ny = Math.min(0.92, Math.max(0, startNy + (ev.clientY - startY) / rect.height));
        node.style.left = anno.nx * rect.width + "px";
        node.style.top = anno.ny * rect.height + "px";
      }
      function up() {
        node.style.cursor = "grab";
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        markSaved();
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ws-anno-remove";
    remove.title = "Remove";
    remove.setAttribute("aria-label", "Remove");
    remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
    remove.addEventListener("pointerdown", (e) => e.stopPropagation());
    remove.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeAnnotation(entry, anno, pageNode);
    });
    node.appendChild(remove);

    const resize = document.createElement("div");
    resize.className = "ws-anno-resize";
    resize.title = "Resize";
    resize.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const layer = node.parentElement;
      if (!layer) return;
      const img = node.querySelector("img");
      if (!img) return;
      pushHistory();
      selectAnno(node, anno, entry, pageNode);
      const rect = layer.getBoundingClientRect();
      const startX = e.clientX;
      const startW = anno.wN;
      const startH = anno.hN;
      const aspect = (startH * rect.height) / Math.max(1, startW * rect.width);
      function move(ev) {
        const widthPx = Math.max(24, startW * rect.width + (ev.clientX - startX));
        let wN = widthPx / rect.width;
        wN = Math.min(1 - anno.nx, wN);
        let hN = (aspect * widthPx) / rect.height;
        if (hN > 1 - anno.ny) {
          hN = 1 - anno.ny;
          wN = (hN * rect.height) / aspect / rect.width;
        }
        anno.wN = wN;
        anno.hN = hN;
        img.style.width = wN * rect.width + "px";
        img.style.height = hN * rect.height + "px";
      }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        markSaved();
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    node.appendChild(resize);
  }

  function selectAnno(node, anno, entry, pageNode) {
    if (state.selAnno && state.selAnno.node) state.selAnno.node.classList.remove("is-anno-selected");
    state.selAnno = { anno, entry, pageNode, node };
    node.classList.add("is-anno-selected");
  }

  async function renderAnnotationLayer(entry, pageNode) {
    const layer = pageNode.querySelector(".ws-anno-layer");
    if (!layer) return;
    layer.innerHTML = "";
    if (!entry.annotations.length) return;
    const viewport = await pageViewport(entry, BASE_SCALE * state.zoom);
    entry.annotations.forEach((a) => {
      layer.appendChild(annotationElement(a, entry, viewport, pageNode));
    });
  }

  /* ================= editable text layer (Edit PDF) ================= */

  function fontFamilyKind(font) {
    const n = String(font || "").toLowerCase();
    if (n.indexOf("courier") !== -1 || n.indexOf("mono") !== -1) return "Courier";
    if (n.indexOf("times") !== -1 || n.indexOf("georgia") !== -1|| n.indexOf("roman") !== -1) return "Times";
    if (n.indexOf("helvetica") !== -1 || n.indexOf("arial") !== -1 || n.indexOf("sans") !== -1) return "Helvetica";
    if (n.indexOf("serif") !== -1) return "Times";
    return "Helvetica";
  }

  function fontFamilyFromName(name) {
    const kind = fontFamilyKind(name);
    if (kind === "Times") return "Times New Roman, Times, serif";
    if (kind === "Courier") return "Courier New, Courier, monospace";
    return "Helvetica, Arial, sans-serif";
  }

  function standardFontKey(font, bold, italic) {
    return fontFamilyKind(font) + "|" + (bold ? "b" : "") + (italic ? "i" : "");
  }

  function standardFontName(font, bold, italic) {
    const fam = fontFamilyKind(font);
    if (fam === "Times") {
      if (bold && italic) return PDFLib.StandardFonts.TimesRomanBoldItalic;
      if (bold) return PDFLib.StandardFonts.TimesRomanBold;
      if (italic) return PDFLib.StandardFonts.TimesRomanItalic;
      return PDFLib.StandardFonts.TimesRoman;
    }
    if (fam === "Courier") {
      if (bold && italic) return PDFLib.StandardFonts.CourierBoldOblique;
      if (bold) return PDFLib.StandardFonts.CourierBold;
      if (italic) return PDFLib.StandardFonts.CourierOblique;
      return PDFLib.StandardFonts.Courier;
    }
    if (bold && italic) return PDFLib.StandardFonts.HelveticaBoldOblique;
    if (bold) return PDFLib.StandardFonts.HelveticaBold;
    if (italic) return PDFLib.StandardFonts.HelveticaOblique;
    return PDFLib.StandardFonts.Helvetica;
  }

  async function ensureTextItems(entry) {
    if (entry.textItems) return entry.textItems;
    const src = state.sources[entry.fileId];
    const pj = await src.pdf.getPage(entry.sourceIndex + 1);
    const viewport = pj.getViewport({ scale: 1, rotation: totalRotation(entry) });
    const content = await pj.getTextContent();
    const items = [];
    content.items.forEach((item) => {
      const str = item.str;
      if (!str || !str.trim()) return;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      if (!fontHeight) return;
      const left = tx[4];
      const top = tx[5] - fontHeight;
      items.push({
        str,
        nx: left / viewport.width,
        ny: top / viewport.height,
        nw: ((item.width || 0) * 1) / viewport.width,
        nh: fontHeight / viewport.height,
        fontSizeN: fontHeight / viewport.width,
        font: fontFamilyFromName(item.fontName),
        bold: /bold|black|heavy|semibold/i.test(item.fontName || ""),
        italic: /italic|oblique/i.test(item.fontName || ""),
        color: "#000000",
      });
    });
    entry.textItems = items;
    entry.editedItems = entry.editedItems || {};
    return items;
  }

  function sampleBackground(canvas, nx, ny, nw, nh) {
    try {
      const ctx = canvas.getContext("2d");
      const x = Math.min(canvas.width - 1, Math.max(0, Math.round(nx * canvas.width) + 1));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.round((ny + nh / 2) * canvas.height)));
      const d = ctx.getImageData(x, y, 1, 1).data;
      return "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    } catch (err) {
      return "#ffffff";
    }
  }

  async function renderEditTextLayer(entry, wrap, canvas) {
    wrap.querySelectorAll(".ws-text-layer").forEach((n) => n.remove());
    const layer = document.createElement("div");
    layer.className = "ws-text-layer";
    layer.style.width = canvas.width + "px";
    layer.style.height = canvas.height + "px";
    const items = await ensureTextItems(entry);
    const edited = entry.editedItems || {};
    items.forEach((it, idx) => {
      if (edited[idx]) return;
      const span = document.createElement("span");
      span.className = "ws-text-item";
      span.textContent = it.str;
      span.style.left = it.nx * canvas.width + "px";
      span.style.top = it.ny * canvas.height + "px";
      span.style.fontSize = it.fontSizeN * canvas.width + "px";
      span.style.fontFamily = it.font;
      span.style.fontWeight = it.bold ? "700" : "400";
      span.style.fontStyle = it.italic ? "italic" : "normal";
      span.style.width = Math.max(6, it.nw * canvas.width) + "px";
      span.style.height = Math.max(6, it.nh * canvas.height) + "px";
      span.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!isEditTool()) return;
        beginTextEdit(entry, wrap, canvas, span, idx, it);
      });
      layer.appendChild(span);
    });
    wrap.appendChild(layer);
    return layer;
  }

  function beginTextEdit(entry, wrap, canvas, span, idx, item) {
    if (wrap.querySelector(".ws-text-edit-box")) return;
    const box = document.createElement("div");
    box.className = "ws-text-edit-box";
    box.style.left = span.style.left;
    box.style.top = span.style.top;
    box.style.width = Math.max(70, parseFloat(span.style.width) + 36) + "px";
    box.style.height = Math.max(20, parseFloat(span.style.fontSize) * 1.5) + "px";

    const ta = document.createElement("textarea");
    ta.className = "ws-text-edit";
    ta.value = item.str;
    ta.style.fontSize = span.style.fontSize;
    ta.style.fontFamily = span.style.fontFamily;
    ta.style.fontWeight = span.style.fontWeight;
    ta.style.fontStyle = span.style.fontStyle;

    const cut = document.createElement("button");
    cut.type = "button";
    cut.className = "ws-text-cut";
    cut.title = "Cut this text";
    cut.setAttribute("aria-label", "Cut text");
    cut.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
    cut.addEventListener("mousedown", (e) => e.preventDefault());
    cut.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      ta.value = "";
      commit();
    });

    box.append(ta, cut);
    wrap.appendChild(box);
    span.style.visibility = "hidden";
    ta.focus();
    ta.select();

    let settled = false;
    function cleanup() {
      box.remove();
    }
    function cancel() {
      if (settled) return;
      settled = true;
      cleanup();
      span.style.visibility = "";
    }
    function commit() {
      if (settled) return;
      settled = true;
      const value = ta.value;
      cleanup();
      if (value === item.str) {
        span.style.visibility = "";
        return;
      }
      applyTextReplacement(entry, wrap, canvas, item, value);
    }
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commit();
      }
    });
  }

  function applyTextReplacement(entry, wrap, canvas, item, value) {
    pushHistory();
    const bg = sampleBackground(canvas, item.nx, item.ny, item.nw, item.nh);
    item.edited = true;
    entry.editedItems[entry.textItems.indexOf(item)] = true;
    entry.annotations.push({
      id: annoSeq++,
      type: "cover",
      nx: Math.max(0, item.nx - 0.002),
      ny: Math.max(0, item.ny - 0.004),
      wN: Math.max(item.nw, 0.006) + 0.004,
      hN: Math.max(item.nh, 0.01) + 0.008,
      color: bg,
    });
    if (value.trim() !== "") {
      entry.annotations.push({
        id: annoSeq++,
        type: "text",
        nx: item.nx,
        ny: item.ny + item.nh,
        text: value,
        sizeN: item.fontSizeN,
        color: item.color,
        font: item.font,
        bold: item.bold,
        italic: item.italic,
      });
    }
    renderAnnotationLayer(entry, wrap);
    renderEditTextLayer(entry, wrap, canvas);
    updateMeta();
    markSaved();
    toast(value.trim() === "" ? "Text removed" : "Text updated");
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
    if (entry.cropN) {
      const insetX = canvas.width * entry.cropN;
      const insetY = canvas.height * entry.cropN;
      const cropped = document.createElement("canvas");
      cropped.width = Math.max(1, Math.floor(canvas.width - insetX * 2));
      cropped.height = Math.max(1, Math.floor(canvas.height - insetY * 2));
      cropped.getContext("2d").drawImage(
        canvas,
        insetX,
        insetY,
        cropped.width,
        cropped.height,
        0,
        0,
        cropped.width,
        cropped.height
      );
      return cropped;
    }
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

  function isFileCardTool() {
    return ["merge", "compress", "repair", "unlock"].indexOf(state.selectedTool) !== -1;
  }

  function isPageCardTool() {
    return ["split", "remove", "extract", "organize", "rotate", "crop"].indexOf(state.selectedTool) !== -1;
  }

  function isEditTool() {
    return state.selectedTool === "edit";
  }

  function isOrganizeTool() {
    return isFileCardTool() || isPageCardTool();
  }

  function filePages(fileId) {
    fileId = Number(fileId);
    return state.pages
      .map((page, i) => ({ page, i }))
      .filter((item) => item.page.fileId === fileId);
  }

  function selectedFileIds() {
    const ids = [];
    state.pages.forEach((page, i) => {
      if (state.selected.has(i) && ids.indexOf(page.fileId) === -1) ids.push(page.fileId);
    });
    return ids;
  }

  function selectedFileId() {
    const ids = selectedFileIds();
    if (ids.length) return ids[0];
    const all = orderedFileIds();
    return all.length ? all[0] : null;
  }

  function makeRemoveBtn(onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-card-remove";
    btn.setAttribute("aria-label", "Remove");
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    return btn;
  }

  function removeFile(fileId) {
    fileId = Number(fileId);
    const count = state.pages.filter((page) => page.fileId === fileId).length;
    if (!count && !state.sources[fileId]) return;
    pushHistory();
    state.pages = state.pages.filter((page) => page.fileId !== fileId);
    state.selected.clear();
    if (state.current >= state.pages.length) state.current = Math.max(0, state.pages.length - 1);
    rerender("all");
    toast("Removed PDF");
    markSaved();
  }

  function selectFile(fileId, additive) {
    const indices = state.pages
      .map((page, i) => (page.fileId === Number(fileId) ? i : -1))
      .filter((i) => i >= 0);
    if (!indices.length) return;
    if (!additive) state.selected.clear();
    indices.forEach((i) => state.selected.add(i));
    state.current = indices[0];
    el.pageNumber.value = String(indices[0] + 1);
    const splitInput = document.getElementById("splitAfterPage");
    if (splitInput) {
      splitInput.max = String(Math.max(1, indices.length - 1));
      if (parseInt(splitInput.value, 10) >= indices.length) splitInput.value = "1";
    }
    applySelectionClasses();
    updateSelectionInfo();
    updateMeta();
  }

  async function renderFileThumbs() {
    el.thumbs.innerHTML = "";
    const ids = orderedFileIds();
    for (let n = 0; n < ids.length; n++) {
      const fileId = ids[n];
      const file = state.sources[fileId];
      const first = state.pages.findIndex((page) => page.fileId === fileId);
      if (first < 0) continue;
      const thumb = document.createElement("div");
      thumb.className = "ws-thumb";
      thumb.dataset.fileId = String(fileId);
      thumb.dataset.index = String(first);
      thumb.addEventListener("click", (e) => selectFile(fileId, e.shiftKey || e.metaKey || e.ctrlKey));
      el.thumbs.appendChild(thumb);
      await renderThumb(first, thumb);
      const num = thumb.querySelector(".ws-thumb-num");
      if (num) num.textContent = String(n + 1);
      const label = document.createElement("span");
      label.className = "ws-thumb-file";
      label.textContent = file ? file.name : "PDF";
      thumb.appendChild(label);
    }
  }

  async function renderThumbs() {
    el.thumbs.innerHTML = "";
    if (false && isOrganizeTool()) {
      await renderFileThumbs();
      return;
    }
    for (let i = 0; i < state.pages.length; i++) {
      const thumb = document.createElement("div");
      thumb.className = "ws-thumb";
      thumb.dataset.index = String(i);
      thumb.addEventListener("click", (e) => selectPage(i, e.shiftKey || e.metaKey || e.ctrlKey));
      el.thumbs.appendChild(thumb);
      renderThumb(i, thumb);
    }
  }

  function orderedFileIds() {
    const ids = [];
    state.pages.forEach((page) => {
      if (ids.indexOf(page.fileId) === -1) ids.push(page.fileId);
    });
    return ids;
  }

  function bindCardDrag(node, payload, onDrop) {
    node.draggable = true;
    node.addEventListener("dragstart", (e) => {
      node.classList.add("is-dragging");
      el.pageStack.classList.add("is-sorting");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", payload);
    });
    node.addEventListener("dragend", () => {
      node.classList.remove("is-dragging");
      el.pageStack.classList.remove("is-sorting");
      document.querySelectorAll(".is-drop-target").forEach((n) => n.classList.remove("is-drop-target"));
    });
    node.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!node.classList.contains("is-drop-target")) {
        document.querySelectorAll(".is-drop-target").forEach((n) => n.classList.remove("is-drop-target"));
        node.classList.add("is-drop-target");
      }
    });
    node.addEventListener("dragleave", (e) => {
      if (!node.contains(e.relatedTarget)) node.classList.remove("is-drop-target");
    });
    node.addEventListener("drop", (e) => {
      e.preventDefault();
      node.classList.remove("is-drop-target");
      if (e.dataTransfer.files && e.dataTransfer.files.length) return;
      e.stopPropagation();
      const payload = e.dataTransfer.getData("text/plain");
      if (!payload) return;
      onDrop(payload);
    });
  }

  function movePageTo(fromIndex, toIndex) {
    fromIndex = Number(fromIndex);
    toIndex = Number(toIndex);
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    pushHistory();
    const item = state.pages.splice(fromIndex, 1)[0];
    if (fromIndex < toIndex) toIndex -= 1;
    state.pages.splice(toIndex, 0, item);
    state.selected = new Set([toIndex]);
    const fromNode = el.pageStack.querySelector('.ws-page[data-index="' + fromIndex + '"]');
    const toNode = el.pageStack.querySelector('.ws-page[data-index="' + toIndex + '"]');
    if (fromNode && toNode && fromNode !== toNode) {
      if (fromIndex < toIndex) el.pageStack.insertBefore(fromNode, toNode.nextSibling);
      else el.pageStack.insertBefore(fromNode, toNode);
      el.pageStack.querySelectorAll(".ws-page[data-index]").forEach((card, i) => {
        card.dataset.index = String(i);
        const num = card.querySelector(".ws-page-num, .ws-card-caption");
        if (num && card.querySelector(".ws-page-num")) num.textContent = String(i + 1);
        const caption = card.querySelector(".ws-card-caption");
        if (caption) caption.textContent = "Page " + (i + 1);
      });
      applySelectionClasses();
      updateMeta();
      markSaved();
      return;
    }
    rerender("all");
    markSaved();
  }

  function moveFileTo(fromId, toId) {
    fromId = Number(fromId);
    toId = Number(toId);
    if (fromId === toId) return;
    pushHistory();
    const moving = state.pages.filter((page) => page.fileId === fromId);
    const remaining = state.pages.filter((page) => page.fileId !== fromId);
    let insertAt = remaining.findIndex((page) => page.fileId === toId);
    if (insertAt < 0) insertAt = remaining.length;
    remaining.splice(insertAt, 0, ...moving);
    state.pages = remaining;
    const fromNode = el.pageStack.querySelector('.ws-file-card[data-file-id="' + fromId + '"]');
    const toNode = el.pageStack.querySelector('.ws-file-card[data-file-id="' + toId + '"]');
    if (fromNode && toNode && fromNode !== toNode) {
      el.pageStack.insertBefore(fromNode, toNode);
      applySelectionClasses();
      updateMeta();
      markSaved();
      return;
    }
    rerender("all");
    markSaved();
  }

  async function renderFileCards() {
    el.pageStack.classList.add("is-cards");
    const ids = orderedFileIds();
    for (let n = 0; n < ids.length; n++) {
      const fileId = ids[n];
      const file = state.sources[fileId];
      if (!file) continue;
      const pages = filePages(fileId);
      const firstPage = pages.length ? pages[0].page : null;
      const wrap = document.createElement("div");
      wrap.className = "ws-page ws-page-card ws-file-card";
      wrap.dataset.fileId = String(fileId);

      const sheet = document.createElement("div");
      sheet.className = "ws-card-sheet";
      const cover = document.createElement("div");
      cover.className = "ws-card-cover";
      if (firstPage) {
        const canvas = await renderPageCanvas(firstPage, 0.42);
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        cover.appendChild(canvas);
      }
      sheet.appendChild(cover);

      const hover = document.createElement("div");
      hover.className = "ws-file-hover";
      const rotateBtn = document.createElement("button");
      rotateBtn.type = "button";
      rotateBtn.title = "Rotate";
      rotateBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.2-5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 5v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      rotateBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectFile(fileId, false);
        rotateSelection(90);
      });
      hover.appendChild(rotateBtn);
      hover.appendChild(makeRemoveBtn(() => removeFile(fileId)));
      sheet.appendChild(hover);

      const stats = document.createElement("span");
      stats.className = "ws-file-stats";
      stats.textContent = formatSize(file.size) + " - " + pages.length + " page" + (pages.length === 1 ? "" : "s");
      wrap.appendChild(stats);
      wrap.appendChild(sheet);

      const meta = document.createElement("div");
      meta.className = "ws-card-meta";
      const caption = document.createElement("span");
      caption.className = "ws-card-caption";
      caption.textContent = file.name;
      meta.appendChild(caption);
      wrap.appendChild(meta);
      wrap.addEventListener("click", (e) => {
        selectFile(fileId, e.shiftKey || e.metaKey || e.ctrlKey);
      });
      bindCardDrag(wrap, String(fileId), (from) => moveFileTo(from, fileId));
      el.pageStack.appendChild(wrap);
    }

    if (!isFileCardTool()) {
      const adder = document.createElement("button");
      adder.type = "button";
      adder.className = "ws-add-card";
      adder.innerHTML = "<span>+</span><b>Add PDF</b><em>or drop files here</em>";
      adder.addEventListener("click", () => el.fileInput.click());
      el.pageStack.appendChild(adder);
    }
    applySelectionClasses();
    updateAddFab();
  }

  function hoverAction(label, svg, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-hover-btn";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = svg;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    return btn;
  }

  async function renderPageCards() {
    el.pageStack.classList.add("is-cards");
    const scale = 0.38;
    for (let i = 0; i < state.pages.length; i++) {
      const entry = state.pages[i];
      const wrap = document.createElement("div");
      wrap.className = "ws-page ws-page-card ws-thumb-card";
      if (state.selectedTool === "remove") wrap.classList.add("is-remove-tool");
      wrap.dataset.index = String(i);

      const sheet = document.createElement("div");
      sheet.className = "ws-card-sheet";
      const cover = document.createElement("div");
      cover.className = "ws-card-cover";
      const canvas = await renderPageCanvas(entry, scale);
      canvas.style.width = "100%";
      canvas.style.height = "auto";
      cover.appendChild(canvas);
      sheet.appendChild(cover);

      const cross = document.createElement("div");
      cross.className = "ws-card-cross";
      cross.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
      sheet.appendChild(cross);

      const hover = document.createElement("div");
      hover.className = "ws-file-hover";
      const rotateBtn = document.createElement("button");
      rotateBtn.type = "button";
      rotateBtn.title = "Rotate";
      rotateBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.2-5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 5v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      rotateBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        rotateOne(i, 90);
      });
      hover.appendChild(rotateBtn);
      hover.appendChild(makeRemoveBtn(() => deleteOne(i)));
      sheet.appendChild(hover);
      wrap.appendChild(sheet);

      const caption = document.createElement("span");
      caption.className = "ws-card-caption";
      caption.textContent = "Page " + (i + 1);
      wrap.appendChild(caption);

      wrap.addEventListener("click", (e) => {
        if (e.target.closest(".ws-hover-bar")) return;
        selectPage(i, e.shiftKey || e.metaKey || e.ctrlKey);
      });
      wrap.addEventListener("dblclick", (e) => {
        e.preventDefault();
        openLightbox(i);
      });
      bindCardDrag(wrap, String(i), (from) => movePageTo(from, wrap.dataset.index));
      el.pageStack.appendChild(wrap);
    }
    applySelectionClasses();
    updateAddFab();
  }

  function rotateOne(index, delta) {
    if (!state.pages[index]) return;
    pushHistory();
    state.pages[index].rotation = (state.pages[index].rotation + delta + 360) % 360;
    state.selected = new Set([index]);
    rerender("all");
    markSaved();
  }

  function deleteOne(index) {
    if (!state.pages[index]) return;
    pushHistory();
    state.pages.splice(index, 1);
    state.selected.clear();
    if (state.current >= state.pages.length) state.current = Math.max(0, state.pages.length - 1);
    rerender("all");
    toast("Page removed");
    markSaved();
  }

  function duplicatePage(index) {
    const entry = state.pages[index];
    if (!entry) return;
    pushHistory();
    const copy = {
      fileId: entry.fileId,
      sourceIndex: entry.sourceIndex,
      srcRotation: entry.srcRotation,
      rotation: entry.rotation,
      annotations: JSON.parse(JSON.stringify(entry.annotations || [])),
    };
    state.pages.splice(index + 1, 0, copy);
    state.selected = new Set([index + 1]);
    rerender("all");
    toast("Page duplicated");
    markSaved();
  }

  async function openLightbox(index) {
    const box = document.getElementById("lightbox");
    const stage = document.getElementById("lightboxStage");
    const label = document.getElementById("lightboxLabel");
    if (!box || !stage || !state.pages[index]) return;
    state.current = index;
    stage.innerHTML = "";
    try {
      const canvas = await renderPageCanvas(state.pages[index], 1.35);
      stage.appendChild(canvas);
    } catch (err) {
      console.error(err);
    }
    if (label) label.textContent = "Page " + (index + 1) + " of " + state.pages.length;
    box.hidden = false;
  }

  function closeLightbox() {
    const box = document.getElementById("lightbox");
    if (box) box.hidden = true;
  }

  function rotateAllPages(delta) {
    if (!state.pages.length) {
      toast("Add a PDF first", true);
      return;
    }
    pushHistory();
    state.pages.forEach((page) => {
      page.rotation = (page.rotation + delta + 360) % 360;
    });
    rerender("all");
    toast("Rotated all pages");
    markSaved();
  }

  async function renderStack() {
    el.pageStack.innerHTML = "";
    el.pageStack.classList.remove("is-cards");
    const zoomFloat = document.getElementById("zoomFloat");
    if (zoomFloat) zoomFloat.hidden = isFileCardTool() || isPageCardTool();
    if (!state.pages.length) {
      renderEmptyState();
      return;
    }
    if (isFileCardTool()) {
      await renderFileCards();
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
      layer.addEventListener("click", (e) => {
        if (isEditTool()) handleEditPageClick(e, i, wrap, canvas);
        else handlePageClick(e, i, wrap);
      });
      wrap.appendChild(layer);

      if (isEditTool()) {
        bindShapeDrawing(entry, wrap, layer);
      }

      const badge = document.createElement("span");
      badge.className = "ws-page-badge";
      badge.textContent = "Page " + (i + 1);
      wrap.appendChild(badge);

      wrap.addEventListener("click", (e) => {
        if (isEditTool()) return;
        if (state.tool !== "select") return;
        if (e.target.closest(".ws-anno")) return;
        selectPage(i, e.shiftKey || e.metaKey || e.ctrlKey);
      });

      el.pageStack.appendChild(wrap);
      await renderAnnotationLayer(entry, wrap);
      if (isEditTool()) {
        try {
          await renderEditTextLayer(entry, wrap, canvas);
        } catch (err) {
          console.error(err);
        }
      }
    }
    applySelectionClasses();
  }

  function editTextSizeN(sizePts, canvas) {
    return (sizePts * BASE_SCALE * state.zoom) / Math.max(1, canvas.width);
  }

  function handleEditPageClick(e, index, wrap, canvas) {
    if (!isEditTool()) return;
    if (state.edit.mode !== "add-text") return;
    if (e.target.closest(".ws-text-item") || e.target.closest(".ws-text-edit")) return;
    const rect = canvas.getBoundingClientRect();
    const nx = Math.min(0.98, Math.max(0, (e.clientX - rect.left) / rect.width));
    const ny = Math.min(0.98, Math.max(0, (e.clientY - rect.top) / rect.height));
    const entry = state.pages[index];
    const cfg = state.edit;
    pushHistory();
    entry.annotations.push({
      id: annoSeq++,
      type: "text",
      nx,
      ny,
      text: "New text",
      sizeN: editTextSizeN(cfg.size, canvas),
      color: cfg.color,
      font: cfg.font,
      bold: cfg.bold,
      italic: false,
    });
    renderAnnotationLayer(entry, wrap);
    updateMeta();
    markSaved();
    toast("Text added — use Edit text to change it");
  }

  function bindShapeDrawing(entry, wrap, layer) {
    layer.addEventListener("pointerdown", (e) => {
      if (!isEditTool() || !state.edit.shape) return;
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest(".ws-anno")) return;
      e.preventDefault();
      const rect = layer.getBoundingClientRect();
      const startX = e.clientX - rect.left;
      const startY = e.clientY - rect.top;
      const preview = document.createElement("div");
      preview.className = "ws-anno ws-anno-shape";
      preview.style.border = Math.max(1, 0.004 * rect.width) + "px solid " + state.edit.color;
      preview.style.borderRadius = state.edit.shape === "circle" ? "50%" : "3px";
      preview.style.background = state.edit.color;
      wrap.appendChild(preview);
      const cur = { x: startX, y: startY, box: null };
      function apply() {
        let x = Math.min(startX, cur.x);
        let y = Math.min(startY, cur.y);
        let w = Math.abs(cur.x - startX);
        let h = Math.abs(cur.y - startY);
        if (state.edit.shape === "square") {
          const s = Math.max(w, h);
          if (cur.x < startX) x = startX - s;
          if (cur.y < startY) y = startY - s;
          w = s;
          h = s;
        }
        preview.style.left = x + "px";
        preview.style.top = y + "px";
        preview.style.width = w + "px";
        preview.style.height = h + "px";
        cur.box = { x, y, w, h };
      }
      apply();
      function move(ev) {
        cur.x = ev.clientX - rect.left;
        cur.y = ev.clientY - rect.top;
        apply();
      }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        preview.remove();
        const box = cur.box;
        if (!box || box.w < 4 || box.h < 4) return;
        pushHistory();
        entry.annotations.push({
          id: annoSeq++,
          type: "shape",
          shape: state.edit.shape,
          nx: box.x / rect.width,
          ny: box.y / rect.height,
          wN: box.w / rect.width,
          hN: box.h / rect.height,
          color: state.edit.color,
          strokeWN: 0.004,
          fill: state.edit.color,
        });
        renderAnnotationLayer(entry, wrap);
        updateMeta();
        markSaved();
        toast("Shape added");
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  function renderEmptyState() {
    el.pageStack.classList.remove("is-cards");
    const empty = document.createElement("div");
    empty.className = "ws-empty";
    const copy = isOrganizeTool()
      ? ["Drop PDF files here", "Keep whole PDFs in this workspace. Drag cards to reorder."]
      : ["Your workspace is empty", "Add a PDF or image file to start editing."];
    empty.innerHTML =
      '<div class="ws-empty-art">' +
      '<svg viewBox="0 0 120 120"><path d="M30 16h40l16 16v62a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6V22a6 6 0 0 1 6-6z" fill="#fff" stroke="#cfe6f4" stroke-width="3"/><path d="M70 16v16h16" fill="#e3f2fb"/><rect x="34" y="48" width="34" height="4" rx="2" fill="#d5e8f4"/><rect x="34" y="59" width="26" height="4" rx="2" fill="#d5e8f4"/><path d="M96 40l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#ffd166"/></svg>' +
      "</div>" +
      "<h3>" + copy[0] + "</h3>" +
      "<p>" + copy[1] + "</p>";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-btn ws-btn-primary";
    btn.style.margin = "0 auto";
    btn.textContent = isOrganizeTool() ? "Select PDF files" : "Choose file";
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
    updateAddFab();
  }

  /* ================= selection ================= */

  function applySelectionClasses() {
    document.querySelectorAll(".ws-page[data-index]").forEach((n) =>
      n.classList.toggle("is-selected", state.selected.has(Number(n.dataset.index)))
    );
    document.querySelectorAll(".ws-thumb[data-index]").forEach((n) =>
      n.classList.toggle("is-selected", state.selected.has(Number(n.dataset.index)))
    );
    document.querySelectorAll("[data-file-id]").forEach((n) => {
      const fileId = Number(n.dataset.fileId);
      const selected = state.pages.some((page, i) => page.fileId === fileId && state.selected.has(i));
      n.classList.toggle("is-selected", selected);
    });
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
    const text = n
      ? n + " page" + (n > 1 ? "s" : "") + " selected"
      : "No page selected";
    el.selectionInfo.textContent = text;
    const cmd = document.getElementById("cmdStatus");
    if (cmd) cmd.textContent = n ? n + " selected" : state.pages.length + " pages";
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

    if (state.tool !== "erase" && e.target.closest(".ws-anno")) return;

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
      await placeSignatureOnPage(index, wrap, e.clientX, e.clientY);
    }
  }

  async function placeSignatureOnPage(index, wrap, clientX, clientY) {
    const entry = state.pages[index];
    const layer = wrap.querySelector(".ws-anno-layer");
    const sig = state.pendingSignature;
    if (!entry || !layer || !sig) return;
    const rect = layer.getBoundingClientRect();
    const nx = Math.min(0.92, Math.max(0, (clientX - rect.left) / rect.width - 0.17));
    const ny = Math.min(0.92, Math.max(0, (clientY - rect.top) / rect.height - 0.06));
    pushHistory();
    entry.annotations.push({
      id: annoSeq++,
      type: "sign",
      nx,
      ny,
      wN: 0.34,
      hN: 0.34 * (sig.height / Math.max(1, sig.width)) * (rect.width / Math.max(1, rect.height)),
      dataUrl: sig.dataUrl,
    });
    await renderAnnotationLayer(entry, wrap);
    await renderThumb(index, el.thumbs.querySelectorAll(".ws-thumb")[index]);
    updateMeta();
    markSaved();
    state.pendingSignature = null;
    setTool("select");
    toast("Signature placed — drag it to move or resize");
    status("Signature placed on page " + (index + 1));
  }

  function armPendingSignature(sig) {
    state.pendingSignature = sig;
    state.tool = "sign";
    document.querySelectorAll(".ws-chip").forEach((c) => {
      c.classList.toggle("is-active", c.dataset.mode === "sign");
    });
    el.statusMode.textContent = "Sign mode";
    showSignFloat(sig);
    toast("Drag the signature onto any page");
    status("Drag the signature onto any page");
  }

  function showSignFloat(sig) {
    if (!el.signFloat || !el.signFloatImg) return;
    el.signFloatImg.src = sig.dataUrl;
    el.signFloat.hidden = false;
    el.signFloat.classList.add("is-ready");
  }

  function hideSignFloat() {
    if (!el.signFloat) return;
    el.signFloat.hidden = true;
    el.signFloat.classList.remove("is-ready", "is-dragging");
    el.signFloat.style.left = "";
    el.signFloat.style.top = "";
  }

  function bindSignFloat() {
    const floatEl = el.signFloat;
    if (!floatEl) return;
    floatEl.addEventListener("pointerdown", (e) => {
      if (!state.pendingSignature) return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      const rect = floatEl.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;
      floatEl.classList.add("is-dragging");
      floatEl.style.right = "auto";
      floatEl.style.bottom = "auto";
      floatEl.style.left = rect.left + "px";
      floatEl.style.top = rect.top + "px";

      function move(ev) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) moved = true;
        floatEl.style.left = ev.clientX - offsetX + "px";
        floatEl.style.top = ev.clientY - offsetY + "px";
      }

      function up(ev) {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        floatEl.classList.remove("is-dragging");
        floatEl.style.visibility = "hidden";
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        floatEl.style.visibility = "";
        const wrap = under && under.closest(".ws-page");
        if (moved && wrap && wrap.dataset.index != null) {
          const index = parseInt(wrap.dataset.index, 10);
          placeSignatureOnPage(index, wrap, ev.clientX, ev.clientY);
        }
        floatEl.style.left = "";
        floatEl.style.top = "";
        floatEl.style.right = "";
        floatEl.style.bottom = "";
      }

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
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

  if (el.signInput) {
    el.signInput.addEventListener("change", async () => {
      const file = el.signInput.files[0];
      el.signInput.value = "";
      if (!file) return;
      if (!isImageFile(file)) {
        toast("Use a JPG or PNG signature", true);
        return;
      }
      const dataUrl = await readAsDataURL(file);
      const img = new Image();
      img.onload = () => {
        armPendingSignature({
          dataUrl,
          width: img.width,
          height: img.height,
        });
      };
      img.onerror = () => toast("Could not read that signature", true);
      img.src = dataUrl;
    });
  }

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
            closeModal();
            armPendingSignature({
              dataUrl: canvas.toDataURL("image/png"),
              width: canvas.width,
              height: canvas.height,
            });
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

  function sanitizeWinAnsi(text) {
    let out = "";
    for (const ch of String(text)) {
      out += ch.charCodeAt(0) <= 0xff ? ch : "?";
    }
    return out;
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
      if (entry.cropN) {
        const size = copied.getSize();
        const insetX = size.width * entry.cropN;
        const insetY = size.height * entry.cropN;
        copied.setCropBox(insetX, insetY, size.width - insetX * 2, size.height - insetY * 2);
      }

      if (entry.annotations.length) {
        const viewport = await pageViewport(entry, 1);
        for (const a of entry.annotations) {
          const px = a.nx * viewport.width;
          const pyTop = a.ny * viewport.height;
          const pdfPoint = viewport.convertToPdfPoint(px, pyTop);

          if (a.type === "cover") {
            copied.drawRectangle({
              x: pdfPoint[0],
              y: pdfPoint[1] - a.hN * viewport.height,
              width: a.wN * viewport.width,
              height: a.hN * viewport.height,
              color: colorToRgb(a.color || "#ffffff"),
              rotate: PDFLib.degrees(rot),
            });
          } else if (a.type === "shape") {
            const w = a.wN * viewport.width;
            const h = a.hN * viewport.height;
            const borderWidth = Math.max(0.5, a.strokeWN * viewport.width);
            if (a.shape === "circle") {
              const opts = {
                x: pdfPoint[0] + w / 2,
                y: pdfPoint[1] - h / 2,
                xScale: w / 2,
                yScale: h / 2,
                borderColor: colorToRgb(a.color),
                borderWidth: borderWidth,
                rotate: PDFLib.degrees(rot),
              };
              if (a.fill) opts.color = colorToRgb(a.fill);
              copied.drawEllipse(opts);
            } else {
              const opts = {
                x: pdfPoint[0],
                y: pdfPoint[1] - h,
                width: w,
                height: h,
                borderColor: colorToRgb(a.color),
                borderWidth: borderWidth,
                rotate: PDFLib.degrees(rot),
              };
              if (a.fill) opts.color = colorToRgb(a.fill);
              copied.drawRectangle(opts);
            }
          } else if (a.type === "text") {
            const key = "std:" + standardFontKey(a.font, a.bold, a.italic);
            let font = fontCache.get(key);
            if (!font) {
              font = await out.embedFont(standardFontName(a.font, a.bold, a.italic));
              fontCache.set(key, font);
            }
            const lines = String(a.text).split(/\r?\n/);
            const lineHeight = a.sizeN * viewport.width * 1.2;
            lines.forEach((line, li) => {
              copied.drawText(sanitizeWinAnsi(line), {
                x: pdfPoint[0],
                y: pdfPoint[1] - li * lineHeight,
                size: a.sizeN * viewport.width,
                font: font,
                color: colorToRgb(a.color),
                rotate: PDFLib.degrees(rot),
              });
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

  function actionPageIndices() {
    return state.pages.map((_, i) => i);
  }

  async function exportPdf(opts) {
    if (!state.pages.length) {
      toast("Nothing to export yet", true);
      return;
    }
    const options = opts || {};
    const indices = actionPageIndices();
    if (!indices.length) {
      toast("Select a PDF first", true);
      return;
    }
    const out = await withProgress("Building PDF...", (setPct) =>
      buildPdf(indices, (done, total) => setPct(done / total))
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
    if (!state.pages.length) {
      toast("Add a PDF first", true);
      return;
    }
    const input = document.getElementById("splitAfterPage");
    let cut = input ? parseInt(input.value, 10) : 0;
    if (!cut && state.selected.size) cut = Math.max(...selectedIndices()) + 1;
    if (!Number.isFinite(cut) || cut < 1) cut = 1;
    if (cut >= state.pages.length) {
      toast("Pick a page before the last page", true);
      return;
    }
    const all = state.pages.map((_, i) => i);
    const base = baseName(el.fileName.value);
    const first = await withProgress("Splitting document...", (setPct) =>
      buildPdf(all.slice(0, cut), (d, t) => setPct(d / t))
    );
    download(new Blob([await first.save()], { type: "application/pdf" }), base + "-part-1.pdf");
    await new Promise((r) => setTimeout(r, 350));
    const second = await buildPdf(all.slice(cut));
    download(new Blob([await second.save()], { type: "application/pdf" }), base + "-part-2.pdf");
    toast("Split after page " + cut);
    status("Split after page " + cut);
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
    const indices = actionPageIndices();
    if (!indices.length) {
      toast("Select a PDF first", true);
      return;
    }
    const original = totalSourceSize();
    const out = await withProgress("Compressing PDF...", (setPct) =>
      buildPdf(indices, (d, t) => setPct(d / t))
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

  function blackBoxDataUrl() {
    const c = document.createElement("canvas");
    c.width = 8;
    c.height = 8;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 8, 8);
    return c.toDataURL("image/png");
  }

  function addPageNumbers() {
    if (!state.pages.length) {
      toast("Add a file first", true);
      return;
    }
    pushHistory();
    state.pages.forEach((page, i) => {
      page.annotations.push({
        id: annoSeq++,
        type: "text",
        nx: 0.46,
        ny: 0.94,
        text: String(i + 1),
        sizeN: 0.03,
        color: "#333333",
      });
    });
    rerender("all");
    toast("Page numbers added");
    markSaved();
  }

  function cropMargins() {
    const targets = state.selected.size ? selectedIndices() : state.pages.map((_, i) => i);
    if (!targets.length) {
      toast("Add a file first", true);
      return;
    }
    pushHistory();
    targets.forEach((i) => {
      state.pages[i].cropN = 0.06;
    });
    rerender("all");
    toast("Margins cropped. Download to apply.");
    markSaved();
  }

  function startRedact() {
    if (!state.pages.length) {
      toast("Add a file first", true);
      return;
    }
    state.pendingImage = {
      dataUrl: blackBoxDataUrl(),
      wN: 0.28,
      hN: 0.08,
    };
    setTool("image", true);
    toast("Click a page to place a redaction box");
    status("Click a page to redact");
  }

  /* ================= page edits ================= */

  function rotateSelection(delta) {
    if (!state.pages.length) {
      toast("Add a PDF first", true);
      return;
    }
    if (!state.selected.size) {
      rotateAllPages(delta);
      return;
    }
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
    if (isFileCardTool()) {
      const ids = orderedFileIds();
      const selected = selectedFileIds();
      if (!selected.length) {
        toast("Select a PDF first", true);
        return;
      }
      const from = ids.indexOf(selected[0]);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= ids.length) return;
      moveFileTo(ids[from], ids[to]);
      return;
    }
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

  function updateZoomUI() {
    const pct = Math.round(state.zoom * 100) + "%";
    el.zoomLabel.textContent = pct;
    const slider = document.getElementById("zoomSlider");
    if (slider) slider.value = String(Math.round(state.zoom * 100));
    const range = document.getElementById("zoomRange");
    if (range) range.value = String(Math.round(state.zoom * 100));
    const p = document.getElementById("zoomPct");
    if (p) p.textContent = pct;
  }

  function setZoom(value) {
    state.zoom = Math.min(1, Math.max(0.4, +Number(value).toFixed(2)));
    updateZoomUI();
    renderStack();
  }

  function zoomBy(delta) {
    setZoom(state.zoom + delta);
  }

  function scrollToPage(index) {
    const node = el.pageStack.querySelector('.ws-page[data-index="' + index + '"]');
    if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function setTool(mode, silent) {
    if (mode !== "sign") hideSignFloat();
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

  /* ================= Edit PDF toolbar ================= */

  const EDIT_MODE_LABELS = {
    select: "Select",
    "edit-text": "Edit text",
    "add-text": "Add text",
    shape: "Shape",
  };

  function updateEditToolbar() {
    const bar = document.getElementById("editToolbar");
    if (!bar) return;
    bar.hidden = !isEditTool();
    if (!isEditTool()) return;
    const cfg = state.edit;
    document.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.edit === cfg.mode);
    });
    document.querySelectorAll("[data-shape]").forEach((btn) => {
      btn.classList.toggle("is-active", cfg.mode === "shape" && btn.dataset.shape === cfg.shape);
    });
    const bold = document.getElementById("editBold");
    if (bold) bold.classList.toggle("is-active", !!cfg.bold);
    const font = document.getElementById("editFont");
    if (font) font.value = cfg.font;
    const size = document.getElementById("editSize");
    if (size) size.value = String(cfg.size);
    const color = document.getElementById("editColor");
    if (color) color.value = cfg.color;
  }

  function setEditMode(mode) {
    state.edit.mode = mode;
    if (mode !== "shape") state.edit.shape = null;
    updateEditToolbar();
    el.statusMode.textContent = (EDIT_MODE_LABELS[mode] || "Select") + " mode";
    status((EDIT_MODE_LABELS[mode] || "Select") + " mode");
  }

  function setEditShape(shape) {
    state.edit.shape = shape;
    state.edit.mode = "shape";
    updateEditToolbar();
    el.statusMode.textContent = "Shape mode";
    status("Drag on the page to draw a " + shape);
  }

  function bindEditToolbar() {
    const back = document.getElementById("editBack");
    if (back) back.addEventListener("click", () => {
      const key = state.selectedTool || "edit";
      window.location.href = "tool.html?id=" + encodeURIComponent(key);
    });
    document.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => setEditMode(btn.dataset.edit));
    });
    document.querySelectorAll("[data-shape]").forEach((btn) => {
      btn.addEventListener("click", () => setEditShape(btn.dataset.shape));
    });
    const bold = document.getElementById("editBold");
    if (bold) bold.addEventListener("click", () => {
      state.edit.bold = !state.edit.bold;
      updateEditToolbar();
    });
    const font = document.getElementById("editFont");
    if (font) font.addEventListener("change", () => { state.edit.font = font.value; });
    const size = document.getElementById("editSize");
    if (size) size.addEventListener("change", () => {
      const v = parseInt(size.value, 10);
      state.edit.size = Number.isFinite(v) ? Math.min(96, Math.max(4, v)) : 12;
      updateEditToolbar();
    });
    const color = document.getElementById("editColor");
    if (color) color.addEventListener("input", () => { state.edit.color = color.value; });
    const undoBtn = document.getElementById("editUndo");
    if (undoBtn) undoBtn.addEventListener("click", undo);
    updateEditToolbar();
  }

  const WORKSPACES = {
    edit: { title: "Edit PDF", hint: "Click text on the page to edit it, or add text and shapes.", chips: [], page: [], file: ["edit", "info", "files"], tab: "file", mode: "select", action: "Download PDF" },
    watermark: { title: "Watermark PDF", hint: "Stamp text or an image on the page.", chips: ["text", "image", "erase"], page: [], file: ["watermark", "info", "files"], tab: "file", mode: "text" },
    image: { title: "Add Images", hint: "Place photos or graphics onto the PDF.", chips: ["image", "erase"], page: [], file: ["image", "info", "files"], tab: "file", mode: "image" },
    sign: { title: "Sign Document", hint: "Upload a PDF or JPG, then drag a signature onto any page.", chips: ["sign", "erase"], page: [], file: ["sign", "info", "files"], tab: "file", mode: "sign", action: "Download PDF" },
    rotate: { title: "Rotate PDF", hint: "Drag pages to reorder, hover to rotate, then download.", chips: [], page: ["rotate"], file: [], tab: "page", action: "Rotate PDF" },
    split: { title: "Split PDF", hint: "Select a page, then split the document after that page.", chips: [], page: ["split"], file: [], tab: "page", action: "Split PDF" },
    merge: { title: "Merge PDF", hint: "To change the order of your PDFs, drag and drop the files as you want.", chips: [], page: [], file: [], tab: "file", action: "Merge PDF" },
    compress: { title: "Compress PDF", hint: "Review files, then compress and download.", chips: [], page: [], file: [], tab: "file", action: "Compress PDF" },
    protect: { title: "Protect PDF", hint: "Encrypt with AES-256 and set an open password.", chips: [], page: [], file: ["protect", "info", "files"], tab: "file" },
    convert: { title: "Convert PDF", hint: "Export pages as images, or turn images into a PDF.", chips: [], page: [], file: ["pdf-jpg", "jpg-pdf", "info", "files"], tab: "file" },
    "pdf-jpg": { title: "PDF to JPG", hint: "Export each page as a JPG or PNG image.", chips: [], page: [], file: ["pdf-jpg", "info", "files"], tab: "file" },
    "jpg-pdf": { title: "JPG to PDF", hint: "Turn images in this workspace into one PDF.", chips: [], page: [], file: ["jpg-pdf", "info", "files"], tab: "file" },
    "pdf-word": { title: "PDF to Word", hint: "Download a Word-friendly text document.", chips: [], page: [], file: ["pdf-word", "info", "files"], tab: "file" },
    "html-pdf": { title: "HTML to PDF", hint: "Download the converted PDF.", chips: [], page: [], file: ["html-pdf", "info", "files"], tab: "file" },
    unlock: { title: "Unlock PDF", hint: "Download a copy without the password if the file opened.", chips: [], page: [], file: [], tab: "file", action: "Unlock PDF" },
    organize: { title: "Organize PDF", hint: "Sort, delete or rearrange pages.", chips: [], page: ["arrange", "delete"], file: [], tab: "page", action: "Download PDF" },
    extract: { title: "Extract pages", hint: "Select pages, then extract them into a new PDF.", chips: [], page: ["extract"], file: [], tab: "page", action: "Extract PDF" },
    remove: { title: "Remove pages", hint: "Select pages, then delete them from the PDF.", chips: [], page: ["delete"], file: [], tab: "page", action: "Remove pages" },
    repair: { title: "Repair PDF", hint: "Rebuild readable pages into a new file.", chips: [], page: [], file: [], tab: "file", action: "Repair PDF" },
    pagenumbers: { title: "Page numbers", hint: "Stamp a page number on every page.", chips: [], page: [], file: ["pagenumbers", "info", "files"], tab: "file" },
    crop: { title: "Crop PDF", hint: "Trim equal margins from selected pages.", chips: [], page: ["crop"], file: [], tab: "page", action: "Crop PDF" },
    redact: { title: "Redact PDF", hint: "Cover sensitive areas with black boxes.", chips: ["image", "erase"], page: [], file: ["redact", "info", "files"], tab: "file", mode: "image" },
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
    if (isOrganizeTool()) document.documentElement.setAttribute("data-layout", "cards");
    else document.documentElement.removeAttribute("data-layout");
    const railLabel = document.querySelector(".ws-rail-head span");
    if (railLabel) railLabel.textContent = "Pages";
    const pageNav = document.getElementById("pageNavGroup");
    if (pageNav) pageNav.hidden = isOrganizeTool();
    const commandBar = document.getElementById("commandBar");
    if (commandBar) commandBar.hidden = true;
    updateActionDock();

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
      updateEditToolbar();
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
    else setTool("select", true);
    updateEditToolbar();
    updateActionDock();
  }

  function updateActionDock() {
    const dock = document.getElementById("actionDock");
    if (dock) dock.hidden = true;
    const foot = document.getElementById("panelFoot");
    const label = document.getElementById("panelActionLabel");
    const workspace = WORKSPACES[state.selectedTool];
    if (foot && label && workspace && workspace.action) {
      foot.hidden = false;
      label.textContent = workspace.action;
    } else if (foot) {
      foot.hidden = true;
    }
    updateAddFab();
  }

  function updateAddFab() {
    const fab = document.getElementById("addFab");
    const count = document.getElementById("addFabCount");
    if (!fab) return;
    if (isOrganizeTool() && state.pages.length) {
      fab.hidden = false;
      if (count) count.textContent = String(isFileCardTool() ? orderedFileIds().length : state.pages.length);
    } else {
      fab.hidden = true;
    }
  }

  function runPrimaryAction() {
    const tool = state.selectedTool;
    if (tool === "merge") return exportPdf({ suffix: "-merged" });
    if (tool === "compress") return compressAndDownload();
    if (tool === "split") return splitAfterSelection();
    if (tool === "rotate") return exportPdf({ suffix: "-rotated" });
    return exportPdf();
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
    const downloadBtn = document.getElementById("downloadBtn");
    if (downloadBtn) downloadBtn.addEventListener("click", () => exportPdf());
    const addMoreBtn = document.getElementById("addMoreBtn");
    if (addMoreBtn) addMoreBtn.addEventListener("click", () => el.fileInput.click());
    const addFab = document.getElementById("addFab");
    if (addFab) addFab.addEventListener("click", () => el.fileInput.click());
    const panelAction = document.getElementById("panelActionBtn");
    if (panelAction) panelAction.addEventListener("click", () => runPrimaryAction());
    el.fileName.addEventListener("input", markSaved);
    updateZoomUI();
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
    if (addTextBtn) addTextBtn.addEventListener("click", () => setEditMode("add-text"));
    const placeImageBtn = document.getElementById("placeImageBtn");
    if (placeImageBtn) placeImageBtn.addEventListener("click", () => setTool("image"));
    const placeSignBtn = document.getElementById("placeSignBtn");
    if (placeSignBtn) placeSignBtn.addEventListener("click", () => setTool("sign"));
    const uploadSignBtn = document.getElementById("uploadSignBtn");
    if (uploadSignBtn) {
      uploadSignBtn.addEventListener("click", () => {
        state.tool = "sign";
        if (el.signInput) el.signInput.click();
      });
    }
    const placeWatermarkBtn = document.getElementById("placeWatermarkBtn");
    if (placeWatermarkBtn) placeWatermarkBtn.addEventListener("click", () => setTool("text", true));
    const pdfWordBtn = document.getElementById("pdfWordBtn");
    if (pdfWordBtn) pdfWordBtn.addEventListener("click", exportPdfAsText);
    const wordPdfBtn = document.getElementById("wordPdfBtn");
    if (wordPdfBtn) wordPdfBtn.addEventListener("click", () => exportPdf({ suffix: "" }));
    const htmlPdfBtn = document.getElementById("htmlPdfBtn");
    if (htmlPdfBtn) htmlPdfBtn.addEventListener("click", () => exportPdf({ suffix: "" }));
    const unlockBtn = document.getElementById("unlockBtn");
    if (unlockBtn) unlockBtn.addEventListener("click", () => exportPdf({ suffix: "-unlocked" }));
    const repairBtn = document.getElementById("repairBtn");
    if (repairBtn) repairBtn.addEventListener("click", () => exportPdf({ suffix: "-repaired" }));
    const pageNumbersBtn = document.getElementById("pageNumbersBtn");
    if (pageNumbersBtn) pageNumbersBtn.addEventListener("click", addPageNumbers);
    const cropBtn = document.getElementById("cropBtn");
    if (cropBtn) cropBtn.addEventListener("click", cropMargins);
    const redactBtn = document.getElementById("redactBtn");
    if (redactBtn) redactBtn.addEventListener("click", startRedact);

    document.getElementById("selectAllPages").addEventListener("click", () => {
      if (!state.pages.length) return;
      state.selected = new Set(state.pages.map((_, i) => i));
      applySelectionClasses();
      updateSelectionInfo();
      updateMeta();
    });

    const dockAdd = document.getElementById("dockAddBtn");
    if (dockAdd) dockAdd.addEventListener("click", () => el.fileInput.click());
    const primaryAction = document.getElementById("primaryActionBtn");
    if (primaryAction) primaryAction.addEventListener("click", () => runPrimaryAction());

    const cmdAdd = document.getElementById("cmdAdd");
    if (cmdAdd) cmdAdd.addEventListener("click", () => el.fileInput.click());
    const cmdSelectAll = document.getElementById("cmdSelectAll");
    if (cmdSelectAll) cmdSelectAll.addEventListener("click", () => {
      if (!state.pages.length) return;
      state.selected = new Set(state.pages.map((_, i) => i));
      applySelectionClasses();
      updateSelectionInfo();
      updateMeta();
    });
    const cmdDeselect = document.getElementById("cmdDeselect");
    if (cmdDeselect) cmdDeselect.addEventListener("click", () => {
      state.selected.clear();
      applySelectionClasses();
      updateSelectionInfo();
    });
    const cmdRotateAll = document.getElementById("cmdRotateAll");
    if (cmdRotateAll) cmdRotateAll.addEventListener("click", () => rotateAllPages(90));
    const cmdDelete = document.getElementById("cmdDelete");
    if (cmdDelete) cmdDelete.addEventListener("click", deleteSelection);

    const zoomSlider = document.getElementById("zoomSlider");
    if (zoomSlider) {
      zoomSlider.addEventListener("input", () => setZoom(parseInt(zoomSlider.value, 10) / 100));
    }

    const zoomRange = document.getElementById("zoomRange");
    if (zoomRange) {
      zoomRange.addEventListener("input", () => setZoom(parseInt(zoomRange.value, 10) / 100));
    }
    const zoomInBtn = document.getElementById("zoomInBtn");
    if (zoomInBtn) zoomInBtn.addEventListener("click", () => zoomBy(0.1));
    const zoomOutBtn = document.getElementById("zoomOutBtn");
    if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => zoomBy(-0.1));

    const lightboxClose = document.getElementById("lightboxClose");
    if (lightboxClose) lightboxClose.addEventListener("click", closeLightbox);
    const lightboxPrev = document.getElementById("lightboxPrev");
    if (lightboxPrev) lightboxPrev.addEventListener("click", () => openLightbox(Math.max(0, state.current - 1)));
    const lightboxNext = document.getElementById("lightboxNext");
    if (lightboxNext) lightboxNext.addEventListener("click", () => openLightbox(Math.min(state.pages.length - 1, state.current + 1)));
    const lightbox = document.getElementById("lightbox");
    if (lightbox) lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox) closeLightbox();
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
      const incoming = e.dataTransfer.files || [];
      if (!incoming.length) return;
      const added = await addFiles(incoming);
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
      if (e.key === "Escape") {
        closeLightbox();
        closeModal();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const sel = state.selAnno;
        if (sel && sel.entry && state.pages.indexOf(sel.entry) !== -1) {
          removeAnnotation(sel.entry, sel.anno, sel.pageNode);
        } else {
          deleteSelection();
        }
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
    bindEditToolbar();
    bindUpload();
    bindSignFloat();
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
