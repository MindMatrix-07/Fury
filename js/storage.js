/* ─── storage.js ───
   Document-level annotation storage.
   Keeps every page under one document key so page insert/delete/duplicate
   can shift annotation data safely.
*/

const Storage = (() => {
  const PREFIX = 'fury_doc_';

  function _key(docId) {
    return `${PREFIX}${docId}`;
  }

  function _clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function _emptyDoc() {
    return {
      version: 2,
      annotations: {}
    };
  }

  function _read(docId) {
    if (!docId) return _emptyDoc();

    try {
      const raw = localStorage.getItem(_key(docId));
      if (!raw) return _emptyDoc();

      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        return {
          version: 2,
          annotations: { 1: parsed }
        };
      }

      if (parsed && typeof parsed === 'object') {
        return {
          version: parsed.version || 2,
          annotations: parsed.annotations && typeof parsed.annotations === 'object'
            ? parsed.annotations
            : {}
        };
      }
    } catch (error) {
      // Ignore malformed storage and recover with a clean state.
    }

    return _emptyDoc();
  }

  function _write(docId, docState) {
    if (!docId) return;

    try {
      localStorage.setItem(_key(docId), JSON.stringify(docState));
    } catch (error) {
      // Local storage quota errors should not break editing.
    }
  }

  function _sortedPageEntries(annotations) {
    return Object.entries(annotations)
      .map(([page, strokes]) => [parseInt(page, 10), strokes])
      .filter(([page]) => Number.isFinite(page))
      .sort((a, b) => a[0] - b[0]);
  }

  function save(docId, pageNum, strokes) {
    const doc = _read(docId);
    doc.annotations[String(pageNum)] = _clone(strokes || []);
    _write(docId, doc);
  }

  function load(docId, pageNum) {
    const doc = _read(docId);
    return _clone(doc.annotations[String(pageNum)] || []);
  }

  function clearPage(docId, pageNum) {
    const doc = _read(docId);
    delete doc.annotations[String(pageNum)];
    _write(docId, doc);
  }

  function clearDoc(docId) {
    localStorage.removeItem(_key(docId));
  }

  function insertPage(docId, pageNum, strokes = []) {
    const doc = _read(docId);
    const next = {};

    for (const [page, pageStrokes] of _sortedPageEntries(doc.annotations)) {
      const targetPage = page >= pageNum ? page + 1 : page;
      next[String(targetPage)] = pageStrokes;
    }

    next[String(pageNum)] = _clone(strokes);
    doc.annotations = next;
    _write(docId, doc);
  }

  function duplicatePage(docId, sourcePage, insertAtPage) {
    insertPage(docId, insertAtPage, load(docId, sourcePage));
  }

  function deletePage(docId, pageNum) {
    const doc = _read(docId);
    const next = {};

    for (const [page, pageStrokes] of _sortedPageEntries(doc.annotations)) {
      if (page === pageNum) continue;
      const targetPage = page > pageNum ? page - 1 : page;
      next[String(targetPage)] = pageStrokes;
    }

    doc.annotations = next;
    _write(docId, doc);
  }

  return {
    save,
    load,
    clearPage,
    clearDoc,
    insertPage,
    duplicatePage,
    deletePage
  };
})();
