/* ─── toolbar.js ───
   Handles tool selection, colors, zoom, theme, export,
   page actions, and keyboard shortcuts.
*/

const Toolbar = (() => {
  let _onZoomChange = null;
  let _onClearPage = null;
  let _onUndo = null;
  let _onRedo = null;
  let _onExport = null;
  let _onAddPage = null;
  let _onDuplicatePage = null;
  let _onDeletePage = null;
  let _onToolChange = null;

  let _currentZoom = 1.0;
  const ZOOM_STEP = 0.15;
  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 3.0;

  function init({
    onZoomChange,
    onClearPage,
    onUndo,
    onRedo,
    onExport,
    onAddPage,
    onDuplicatePage,
    onDeletePage,
    onToolChange
  }) {
    _onZoomChange = onZoomChange;
    _onClearPage = onClearPage;
    _onUndo = onUndo;
    _onRedo = onRedo;
    _onExport = onExport;
    _onAddPage = onAddPage;
    _onDuplicatePage = onDuplicatePage;
    _onDeletePage = onDeletePage;
    _onToolChange = onToolChange;

    document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => _selectTool(btn.dataset.tool, btn));
    });

    document.querySelectorAll('.color-dot').forEach((dot) => {
      dot.addEventListener('click', () => {
        document.querySelectorAll('.color-dot').forEach((item) => item.classList.remove('active'));
        dot.classList.add('active');
        Annotator.setColor(dot.dataset.color);

        if (dot.classList.contains('highlight')) {
          _selectTool('highlighter', document.getElementById('tool-highlighter'));
        }
      });
    });

    const customColor = document.getElementById('custom-color');
    if (customColor) {
      customColor.addEventListener('input', () => {
        document.querySelectorAll('.color-dot').forEach((item) => item.classList.remove('active'));
        customColor.closest('.color-dot')?.classList.add('active');
        Annotator.setColor(customColor.value);
      });
    }

    const slider = document.getElementById('stroke-size');
    slider.addEventListener('input', () => {
      Annotator.setStrokeSize(parseInt(slider.value, 10));
    });

    document.getElementById('zoom-in').addEventListener('click', () => {
      _setZoom(_currentZoom + ZOOM_STEP);
    });

    document.getElementById('zoom-out').addEventListener('click', () => {
      _setZoom(_currentZoom - ZOOM_STEP);
    });

    const themeBtn = document.getElementById('theme-toggle');
    const iconLight = document.getElementById('theme-icon-light');
    const iconDark = document.getElementById('theme-icon-dark');
    const savedTheme = localStorage.getItem('fury_theme') || 'light';
    _applyTheme(savedTheme, iconLight, iconDark);

    themeBtn.addEventListener('click', () => {
      const nextTheme = document.body.classList.contains('dark') ? 'light' : 'dark';
      _applyTheme(nextTheme, iconLight, iconDark);
      localStorage.setItem('fury_theme', nextTheme);
    });

    document.getElementById('clear-page-btn').addEventListener('click', () => {
      if (_onClearPage) _onClearPage();
    });

    document.getElementById('undo-btn').addEventListener('click', () => {
      if (_onUndo) _onUndo();
    });

    document.getElementById('redo-btn').addEventListener('click', () => {
      if (_onRedo) _onRedo();
    });

    document.getElementById('export-btn')?.addEventListener('click', () => {
      if (_onExport) _onExport();
    });

    document.getElementById('add-page-btn')?.addEventListener('click', () => {
      if (_onAddPage) _onAddPage();
    });

    document.getElementById('duplicate-page-btn')?.addEventListener('click', () => {
      if (_onDuplicatePage) _onDuplicatePage();
    });

    document.getElementById('delete-page-btn')?.addEventListener('click', () => {
      if (_onDeletePage) _onDeletePage();
    });

    document.addEventListener('keydown', _onKey);

    Annotator.setColor(document.querySelector('.color-dot.active')?.dataset.color || '#111111');
    Annotator.setStrokeSize(parseInt(slider.value, 10));
    setHistoryState(false, false);
  }

  function _selectTool(tool, btn) {
    if (!btn) return;

    document.querySelectorAll('.tool-btn[data-tool]').forEach((button) => {
      button.classList.remove('active');
    });

    btn.classList.add('active');
    Annotator.setTool(tool);
    if (typeof _onToolChange === 'function') {
      _onToolChange(tool);
    }
  }

  function _setZoom(level) {
    _currentZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
    document.getElementById('zoom-label').textContent = `${Math.round(_currentZoom * 100)}%`;
    if (_onZoomChange) _onZoomChange(_currentZoom);
  }

  function _applyTheme(theme, iconLight, iconDark) {
    if (theme === 'dark') {
      document.body.classList.add('dark');
      document.body.classList.remove('light');
      iconLight.style.display = 'none';
      iconDark.style.display = '';
    } else {
      document.body.classList.add('light');
      document.body.classList.remove('dark');
      iconLight.style.display = '';
      iconDark.style.display = 'none';
    }
  }

  function _onKey(event) {
    const typingInField = event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA';

    if (!typingInField) {
      const tool = {
        v: 'select',
        p: 'pen',
        h: 'highlighter',
        e: 'eraser',
        t: 'text',
        s: 'shapes',
        l: 'laser'
      }[event.key.toLowerCase()];

      if (tool) {
        const btn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
        if (btn) _selectTool(tool, btn);
      }
    }

    if (event.ctrlKey || event.metaKey) {
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        _setZoom(_currentZoom + ZOOM_STEP);
        return;
      }

      if (event.key === '-') {
        event.preventDefault();
        _setZoom(_currentZoom - ZOOM_STEP);
        return;
      }

      if (event.key === '0') {
        event.preventDefault();
        _setZoom(1.0);
        return;
      }

      if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        if (_onUndo) _onUndo();
        return;
      }

      if (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey)) {
        event.preventDefault();
        if (_onRedo) _onRedo();
      }
    }
  }

  function setHistoryState(canUndo, canRedo) {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');

    if (undoBtn) undoBtn.disabled = !canUndo;
    if (redoBtn) redoBtn.disabled = !canRedo;
  }

  function getZoom() {
    return _currentZoom;
  }

  function setZoom(zoomLevel) {
    _setZoom(zoomLevel);
  }

  return {
    init,
    getZoom,
    setZoom,
    setHistoryState
  };
})();
