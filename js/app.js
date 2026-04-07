/* ─── app.js ───
   Main entry point for Fury.
   Handles PDF loading, notebook creation, page rendering,
   pan/zoom behavior, and exporting annotated PDFs.
*/

(() => {
  let _pdfDoc = null;
  let _pdfBytes = null;
  let _zoom = 1.0;
  let _docId = null;
  let _docName = 'Untitled.pdf';
  let _numPages = 0;
  let _rendered = new Set();
  let _lazyObserver = null;
  let _statusTimer = null;
  let _panState = null;

  const BASE_WIDTH = 760;

  const splash = document.getElementById('splash');
  const app = document.getElementById('app');
  const pagesEl = document.getElementById('pages-container');
  const viewerWrap = document.getElementById('viewer-wrap');
  const docTitleEl = document.getElementById('doc-title');
  const pageTotalEl = document.getElementById('page-total');
  const statusEl = document.getElementById('status-pill');
  const createNotebookBtn = document.getElementById('create-notebook-btn');
  const openButtons = [
    document.getElementById('open-btn'),
    document.getElementById('open-btn-2')
  ];
  const pdfInputs = [
    document.getElementById('pdf-input'),
    document.getElementById('pdf-input-2')
  ];

  openButtons.forEach((button, index) => {
    button?.addEventListener('click', async () => {
      if (window.furyDesktop?.isDesktop) {
        await _openViaDesktopDialog();
      } else {
        pdfInputs[index]?.click();
      }
    });
  });

  pdfInputs.forEach((input) => {
    input?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      await _loadFile(file);
    });
  });

  createNotebookBtn?.addEventListener('click', _createNotebook);

  Toolbar.init({
    onZoomChange: (zoom) => {
      _zoom = zoom;
      _reRenderAll();
    },
    onClearPage: _clearCurrentPage,
    onUndo: _undoCurrentPage,
    onRedo: _redoCurrentPage,
    onExport: _exportPdf,
    onAddPage: _addBlankPage,
    onDuplicatePage: _duplicateCurrentPage,
    onDeletePage: _deleteCurrentPage,
    onToolChange: _syncInteractionMode
  });

  Annotator.setOnChange((pageNum) => {
    if (pageNum === _currentPage()) {
      _syncHistoryButtons();
    }
  });

  _setupPanAndZoom();
  _setupDragAndDrop();
  _setupDesktopBridge();

  async function _loadFile(file) {
    if (!file) return;

    try {
      const bytes = file.bytes
        ? new Uint8Array(file.bytes)
        : new Uint8Array(await file.arrayBuffer());
      const docId = file.path || `${file.name}::${file.size}::${file.lastModified}`;
      await _loadDocument({
        bytes,
        docId,
        name: file.name,
        focusPage: 1
      });
      _showStatus(`Opened ${file.name}`, 'success');
    } catch (error) {
      _showStatus('Could not open that PDF.', 'danger');
    }
  }

  async function _createNotebook() {
    try {
      const pdf = await PDFLib.PDFDocument.create();
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const page = pdf.addPage([595.28, 841.89]);
        _decorateNotebookPage(page);
      }

      const now = new Date();
      const docId = `notebook-${now.getTime()}`;
      const name = `Notebook-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.pdf`;

      await _loadDocument({
        bytes: new Uint8Array(await pdf.save()),
        docId,
        name,
        focusPage: 1
      });

      _showStatus('Created a new lined notebook.', 'success');
    } catch (error) {
      _showStatus('Could not create the notebook.', 'danger');
    }
  }

  function _decorateNotebookPage(page) {
    const { rgb } = PDFLib;
    const width = page.getWidth();
    const height = page.getHeight();
    const margin = 48;

    page.drawRectangle({
      x: 0,
      y: 0,
      width,
      height,
      color: rgb(0.996, 0.995, 0.99)
    });

    for (let y = height - 76; y > 40; y -= 24) {
      page.drawLine({
        start: { x: margin, y },
        end: { x: width - margin, y },
        thickness: 0.65,
        color: rgb(0.87, 0.9, 0.94),
        opacity: 0.85
      });
    }

    page.drawLine({
      start: { x: 84, y: 38 },
      end: { x: 84, y: height - 38 },
      thickness: 0.9,
      color: rgb(0.95, 0.72, 0.72),
      opacity: 0.9
    });
  }

  async function _loadDocument({ bytes, docId, name, focusPage = 1 }) {
    if (_lazyObserver) {
      _lazyObserver.disconnect();
      _lazyObserver = null;
    }

    _openAppShell();
    _rendered = new Set();
    _pdfBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    _docId = docId;
    _docName = name;
    _pdfDoc = await pdfjsLib.getDocument({ data: _pdfBytes.slice() }).promise;
    _numPages = _pdfDoc.numPages;

    Annotator.resetPages();
    Annotator.setDocId(_docId);

    docTitleEl.textContent = _docName;
    document.title = `Fury — ${_docName}`;
    pageTotalEl.textContent = _numPages;
    pagesEl.innerHTML = '';

    await Sidebar.render(_pdfDoc, viewerWrap);

    for (let pageNum = 1; pageNum <= _numPages; pageNum += 1) {
      _createPageSkeleton(pageNum);
    }

    const eagerPages = Math.min(3, _numPages);
    for (let pageNum = 1; pageNum <= eagerPages; pageNum += 1) {
      await _renderPage(pageNum);
    }

    if (_numPages > eagerPages) {
      _lazyRenderRemaining(eagerPages + 1);
    }

    Sidebar.observePages(() => {
      _syncHistoryButtons();
    });

    _syncInteractionMode(Annotator.getTool());
    _syncHistoryButtons();

    const targetPage = Math.max(1, Math.min(focusPage, _numPages || 1));
    requestAnimationFrame(() => Sidebar.scrollTo(targetPage, 'instant'));
  }

  function _openAppShell() {
    splash.classList.add('fade-out');
    setTimeout(() => splash.classList.add('hidden'), 420);
    app.classList.remove('hidden');
  }

  function _createPageSkeleton(pageNum) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.dataset.page = pageNum;

    const loader = document.createElement('div');
    loader.className = 'page-loader';
    loader.innerHTML = '<div class="spinner"></div>';
    wrapper.appendChild(loader);

    pagesEl.appendChild(wrapper);
  }

  async function _renderPage(pageNum) {
    if (_rendered.has(pageNum)) return;
    _rendered.add(pageNum);

    const wrapper = document.querySelector(`.page-wrapper[data-page="${pageNum}"]`);
    if (!wrapper) return;

    const page = await _pdfDoc.getPage(pageNum);
    const scale = (_zoom * BASE_WIDTH) / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const width = Math.round(viewport.width);
    const height = Math.round(viewport.height);

    wrapper.innerHTML = '';
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;

    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.width = width;
    pdfCanvas.height = height;
    pdfCanvas.style.display = 'block';
    wrapper.appendChild(pdfCanvas);

    await page.render({
      canvasContext: pdfCanvas.getContext('2d'),
      viewport
    }).promise;

    const annotCanvas = document.createElement('canvas');
    annotCanvas.className = 'annot-canvas';
    annotCanvas.style.width = `${width}px`;
    annotCanvas.style.height = `${height}px`;
    wrapper.appendChild(annotCanvas);

    Annotator.initPage(pageNum, annotCanvas, width, height);
    Annotator.setTool(Annotator.getTool());
  }

  function _lazyRenderRemaining(startFrom) {
    _lazyObserver = new IntersectionObserver((entries) => {
      entries.forEach(async (entry) => {
        if (!entry.isIntersecting) return;

        const pageNum = parseInt(entry.target.dataset.page, 10);
        if (!Number.isFinite(pageNum) || _rendered.has(pageNum)) return;

        _lazyObserver.unobserve(entry.target);
        await _renderPage(pageNum);
      });
    }, {
      rootMargin: '240px',
      root: viewerWrap
    });

    for (let pageNum = startFrom; pageNum <= _numPages; pageNum += 1) {
      const wrapper = document.querySelector(`.page-wrapper[data-page="${pageNum}"]`);
      if (wrapper) _lazyObserver.observe(wrapper);
    }
  }

  async function _reRenderAll() {
    if (!_pdfDoc) return;

    const activePage = _currentPage();

    if (_lazyObserver) {
      _lazyObserver.disconnect();
      _lazyObserver = null;
    }

    Annotator.resetPages();
    _rendered = new Set();
    pagesEl.innerHTML = '';

    for (let pageNum = 1; pageNum <= _numPages; pageNum += 1) {
      _createPageSkeleton(pageNum);
    }

    const eagerPages = Math.min(3, _numPages);
    for (let pageNum = 1; pageNum <= eagerPages; pageNum += 1) {
      await _renderPage(pageNum);
    }

    if (_numPages > eagerPages) {
      _lazyRenderRemaining(eagerPages + 1);
    }

    Sidebar.observePages(() => {
      _syncHistoryButtons();
    });
    _syncInteractionMode(Annotator.getTool());

    requestAnimationFrame(() => Sidebar.scrollTo(activePage, 'instant'));
  }

  async function _ensureAllPagesRendered() {
    for (let pageNum = 1; pageNum <= _numPages; pageNum += 1) {
      await _renderPage(pageNum);
    }
  }

  async function _withPdfMutation(mutator, { focusPage } = {}) {
    if (!_pdfBytes) {
      _showStatus('Open or create a document first.', 'danger');
      return false;
    }

    try {
      const pdf = await PDFLib.PDFDocument.load(_pdfBytes);
      await mutator(pdf);
      _pdfBytes = new Uint8Array(await pdf.save());
      await _loadDocument({
        bytes: _pdfBytes,
        docId: _docId,
        name: _docName,
        focusPage: focusPage || _currentPage()
      });
      return true;
    } catch (error) {
      console.error('Document mutation failed', error);
      _showStatus('That document action failed.', 'danger');
      return false;
    }
  }

  async function _addBlankPage() {
    const targetPage = _numPages + 1;
    const saved = await _withPdfMutation((pdf) => {
      const page = pdf.addPage([595.28, 841.89]);
      _decorateNotebookPage(page);
    }, { focusPage: targetPage });

    if (saved) {
      _showStatus('Added a blank page.', 'success');
    }
  }

  async function _duplicateCurrentPage() {
    const currentPage = _currentPage();
    const saved = await _withPdfMutation(async (pdf) => {
      const [copy] = await pdf.copyPages(pdf, [currentPage - 1]);
      pdf.insertPage(currentPage, copy);
      Storage.duplicatePage(_docId, currentPage, currentPage + 1);
    }, { focusPage: currentPage + 1 });

    if (saved) {
      _showStatus(`Duplicated page ${currentPage}.`, 'success');
    }
  }

  async function _deleteCurrentPage() {
    if (_numPages <= 1) {
      _showStatus('A notebook needs at least one page.', 'danger');
      return;
    }

    const currentPage = _currentPage();
    const confirmed = confirm(`Delete page ${currentPage}?`);
    if (!confirmed) return;

    const focusPage = Math.max(1, Math.min(currentPage, _numPages - 1));
    const saved = await _withPdfMutation((pdf) => {
      pdf.removePage(currentPage - 1);
      Storage.deletePage(_docId, currentPage);
    }, { focusPage });

    if (saved) {
      _showStatus(`Deleted page ${currentPage}.`, 'success');
    }
  }

  function _clearCurrentPage() {
    const currentPage = _currentPage();
    if (!currentPage) return;

    if (!Annotator.pageHasContent(currentPage)) {
      _showStatus(`Page ${currentPage} has no annotations to clear.`, 'info');
      return;
    }

    const confirmed = confirm(`Clear all annotations on page ${currentPage}?`);
    if (!confirmed) return;

    const cleared = Annotator.clearCurrentPage(currentPage);
    _syncHistoryButtons();

    if (cleared) {
      _showStatus(`Cleared page ${currentPage}.`, 'success');
    }
  }

  function _undoCurrentPage() {
    const currentPage = _currentPage();
    if (!Annotator.undo(currentPage)) {
      _showStatus('Nothing to undo on this page.', 'info');
      return;
    }

    _syncHistoryButtons();
  }

  function _redoCurrentPage() {
    const currentPage = _currentPage();
    if (!Annotator.redo(currentPage)) {
      _showStatus('Nothing to redo on this page.', 'info');
      return;
    }

    _syncHistoryButtons();
  }

  async function _exportPdf() {
    if (!_pdfBytes || !_pdfDoc) {
      _showStatus('Open or create a document first.', 'danger');
      return;
    }

    _showStatus('Preparing your annotated PDF...', 'info');

    try {
      await _ensureAllPagesRendered();
      const pdf = await PDFLib.PDFDocument.load(_pdfBytes);

      for (let pageNum = 1; pageNum <= pdf.getPageCount(); pageNum += 1) {
        if (!Annotator.pageHasContent(pageNum)) continue;

        const page = pdf.getPage(pageNum - 1);
        const exportCanvas = Annotator.renderPageToCanvas(
          pageNum,
          Math.max(800, Math.round(page.getWidth() * 2)),
          Math.max(1100, Math.round(page.getHeight() * 2))
        );

        const pngImage = await pdf.embedPng(exportCanvas.toDataURL('image/png'));
        page.drawImage(pngImage, {
          x: 0,
          y: 0,
          width: page.getWidth(),
          height: page.getHeight()
        });
      }

      const bytes = new Uint8Array(await pdf.save());
      const suggestedName = _docName.replace(/\.pdf$/i, '') + '-annotated.pdf';

      if (window.furyDesktop?.isDesktop) {
        const result = await window.furyDesktop.savePdf(suggestedName, bytes);
        if (result?.canceled) {
          _showStatus('Export canceled.', 'info');
          return;
        }
      } else {
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = suggestedName;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => URL.revokeObjectURL(url), 1500);
      }

      _showStatus('Exported your annotated PDF.', 'success');
    } catch (error) {
      console.error('Export failed', error);
      _showStatus('Export failed. Try again after the pages finish loading.', 'danger');
    }
  }

  function _currentPage() {
    return parseInt(document.getElementById('page-current').textContent, 10) || 1;
  }

  function _syncHistoryButtons() {
    const currentPage = _currentPage();
    Toolbar.setHistoryState(
      Annotator.canUndo(currentPage),
      Annotator.canRedo(currentPage)
    );
  }

  function _syncInteractionMode(tool) {
    const isPanMode = tool === 'select';
    viewerWrap.classList.toggle('pan-mode', isPanMode);
    if (!isPanMode) {
      viewerWrap.classList.remove('panning');
      _panState = null;
    }
  }

  function _setupPanAndZoom() {
    viewerWrap.addEventListener('pointerdown', (event) => {
      if (Annotator.getTool() !== 'select' || event.button !== 0) return;

      _panState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: viewerWrap.scrollLeft,
        scrollTop: viewerWrap.scrollTop
      };

      viewerWrap.classList.add('panning');
      viewerWrap.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    viewerWrap.addEventListener('pointermove', (event) => {
      if (!_panState) return;
      viewerWrap.scrollLeft = _panState.scrollLeft - (event.clientX - _panState.startX);
      viewerWrap.scrollTop = _panState.scrollTop - (event.clientY - _panState.startY);
    });

    const stopPan = (event) => {
      if (!_panState) return;

      if (event?.pointerId != null && viewerWrap.hasPointerCapture?.(event.pointerId)) {
        viewerWrap.releasePointerCapture(event.pointerId);
      }

      _panState = null;
      viewerWrap.classList.remove('panning');
    };

    viewerWrap.addEventListener('pointerup', stopPan);
    viewerWrap.addEventListener('pointercancel', stopPan);

    viewerWrap.addEventListener('wheel', (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();

      const nextZoom = Toolbar.getZoom() + (event.deltaY < 0 ? 0.1 : -0.1);
      Toolbar.setZoom(nextZoom);
    }, { passive: false });
  }

  function _setupDragAndDrop() {
    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', async (event) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file?.type === 'application/pdf') {
        await _loadFile(file);
      }
    });

    splash.addEventListener('dragover', (event) => {
      event.preventDefault();
      splash.style.outline = '2px dashed var(--accent)';
      splash.style.outlineOffset = '-12px';
    });

    splash.addEventListener('dragleave', () => {
      splash.style.outline = '';
    });

    splash.addEventListener('drop', async (event) => {
      event.preventDefault();
      splash.style.outline = '';
      const file = event.dataTransfer?.files?.[0];
      if (file?.type === 'application/pdf') {
        await _loadFile(file);
      }
    });
  }

  async function _openViaDesktopDialog() {
    if (!window.furyDesktop?.openPdf) return;
    const picked = await window.furyDesktop.openPdf();
    if (picked) {
      await _loadFile(picked);
    }
  }

  function _setupDesktopBridge() {
    if (!window.furyDesktop?.onMenuAction) return;

    window.furyDesktop.onMenuAction(async (action) => {
      if (action === 'open-pdf') {
        await _openViaDesktopDialog();
        return;
      }

      if (action === 'create-notebook') {
        await _createNotebook();
        return;
      }

      if (action === 'export-pdf') {
        await _exportPdf();
      }
    });
  }

  function _showStatus(message, tone = 'info') {
    if (!statusEl) return;

    statusEl.textContent = message;
    statusEl.className = `status-pill ${tone}`;

    clearTimeout(_statusTimer);
    _statusTimer = setTimeout(() => {
      statusEl.classList.add('hidden');
    }, 2800);
  }
})();
