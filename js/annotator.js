/* ─── annotator.js ───
   Canvas-based annotation engine for Fury.
   Handles pen, highlighter, eraser, text, laser, undo/redo,
   and simple GoodNotes-style shape snapping.
*/

const Annotator = (() => {
  let _currentTool = 'pen';
  let _currentColor = '#111111';
  let _strokeSize = 3;
  let _docId = null;
  let _onChange = null;

  const _pages = new Map();
  const _eraserEl = document.createElement('div');
  const _laserEl = document.getElementById('laser-pointer');

  _eraserEl.className = 'eraser-cursor';
  _eraserEl.style.display = 'none';
  document.body.appendChild(_eraserEl);

  function _clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function _clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function _currentPageState(pageNum) {
    return _pages.get(pageNum) || null;
  }

  function _notifyChange(pageNum) {
    if (typeof _onChange === 'function') {
      _onChange(pageNum, {
        canUndo: canUndo(pageNum),
        canRedo: canRedo(pageNum),
        strokeCount: (_pages.get(pageNum)?.strokes || []).length
      });
    }
  }

  function _pushHistory(state) {
    state.undoStack.push(_clone(state.strokes));
    if (state.undoStack.length > 60) {
      state.undoStack.shift();
    }
    state.redoStack = [];
  }

  function _pageWidth(state) {
    return state.canvas.width || 1;
  }

  function _pageHeight(state) {
    return state.canvas.height || 1;
  }

  function _strokeWidthPx(stroke, state) {
    return Math.max(1, (stroke.sizeRatio || 0.004) * _pageWidth(state));
  }

  function _fontSizePx(stroke, state) {
    return Math.max(18, (stroke.fontRatio || 0.03) * _pageWidth(state));
  }

  function _toCanvasPoint(state, point) {
    return {
      x: point.x * _pageWidth(state),
      y: point.y * _pageHeight(state)
    };
  }

  function _fromPointer(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: _clamp01((e.clientX - rect.left) / rect.width),
      y: _clamp01((e.clientY - rect.top) / rect.height)
    };
  }

  function _normalizeLoadedStroke(stroke, width, height) {
    if (!stroke || typeof stroke !== 'object') return null;
    if (stroke.units === 'normalized') return stroke;

    const safeWidth = width || 1;
    const safeHeight = height || 1;

    if (stroke.tool === 'text') {
      return {
        tool: 'text',
        units: 'normalized',
        color: stroke.color || '#111111',
        fontRatio: Math.max(0.018, (Math.max(16, (stroke.size || 4) * 4)) / safeWidth),
        text: stroke.text || '',
        x: _clamp01((stroke.x || 0) / safeWidth),
        y: _clamp01((stroke.y || 0) / safeHeight)
      };
    }

    return {
      tool: stroke.tool === 'shapes' ? 'shape' : (stroke.tool || 'pen'),
      shape: stroke.shape || null,
      units: 'normalized',
      color: stroke.color || '#111111',
      alpha: typeof stroke.alpha === 'number' ? stroke.alpha : 1,
      sizeRatio: Math.max(0.0015, (stroke.size || 3) / safeWidth),
      points: Array.isArray(stroke.points)
        ? stroke.points.map((point) => ({
            x: _clamp01((point.x || 0) / safeWidth),
            y: _clamp01((point.y || 0) / safeHeight)
          }))
        : [],
      start: stroke.start
        ? {
            x: _clamp01((stroke.start.x || 0) / safeWidth),
            y: _clamp01((stroke.start.y || 0) / safeHeight)
          }
        : undefined,
      end: stroke.end
        ? {
            x: _clamp01((stroke.end.x || 0) / safeWidth),
            y: _clamp01((stroke.end.y || 0) / safeHeight)
          }
        : undefined
    };
  }

  function _restoreStrokes(pageNum, width, height) {
    if (!_docId) return [];

    const loaded = Storage.load(_docId, pageNum) || [];
    let migrated = false;
    const normalized = loaded
      .map((stroke) => {
        const next = _normalizeLoadedStroke(stroke, width, height);
        if (next && next.units === 'normalized' && stroke.units !== 'normalized') {
          migrated = true;
        }
        return next;
      })
      .filter(Boolean);

    if (migrated) {
      Storage.save(_docId, pageNum, normalized);
    }

    return normalized;
  }

  function initPage(pageNum, canvas, width, height) {
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const strokes = _restoreStrokes(pageNum, width, height);
    const state = {
      pageNum,
      canvas,
      ctx,
      strokes,
      drawing: false,
      currentStroke: null,
      undoStack: [],
      redoStack: [],
      erasing: false
    };

    _pages.set(pageNum, state);
    _redraw(state);

    canvas.addEventListener('pointerdown', (e) => _onDown(e, pageNum, state));
    canvas.addEventListener('pointermove', (e) => _onMove(e, pageNum, state));
    canvas.addEventListener('pointerup', (e) => _onUp(e, pageNum, state));
    canvas.addEventListener('pointerout', (e) => _onUp(e, pageNum, state));
    canvas.addEventListener('pointerleave', () => {
      _hideLaser();
      if (_currentTool !== 'eraser') {
        _eraserEl.style.display = 'none';
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function _onDown(e, pageNum, state) {
    if (_currentTool === 'select') return;
    if (_currentTool === 'text') {
      _placeText(e, pageNum, state);
      return;
    }

    e.preventDefault();
    state.drawing = true;

    if (_currentTool === 'laser') {
      _showLaser(e);
      return;
    }

    const point = _fromPointer(e, state.canvas);

    if (_currentTool === 'eraser') {
      _eraseAt(point, pageNum, state);
      return;
    }

    const isHighlighter = _currentTool === 'highlighter';
    state.currentStroke = {
      tool: _currentTool === 'shapes' ? 'shape-preview' : _currentTool,
      units: 'normalized',
      color: _currentColor,
      alpha: isHighlighter ? 0.32 : 1,
      sizeRatio: (_currentTool === 'highlighter'
        ? Math.max(_strokeSize * 4, 16)
        : _strokeSize) / _pageWidth(state),
      points: [point]
    };

    _redraw(state, _currentTool === 'shapes'
      ? _previewShape(state.currentStroke)
      : state.currentStroke);
  }

  function _onMove(e, pageNum, state) {
    if (_currentTool === 'laser') {
      _showLaser(e);
      return;
    }

    if (_currentTool === 'eraser') {
      _showEraser(e, state);
      if (state.drawing) {
        _eraseAt(_fromPointer(e, state.canvas), pageNum, state);
      }
      return;
    }

    _eraserEl.style.display = 'none';

    if (!state.drawing || !state.currentStroke || _currentTool === 'select') return;

    state.currentStroke.points.push(_fromPointer(e, state.canvas));
    _redraw(state, _currentTool === 'shapes'
      ? _previewShape(state.currentStroke)
      : state.currentStroke);
  }

  function _onUp(e, pageNum, state) {
    _hideLaser();

    if (_currentTool === 'eraser') {
      state.drawing = false;
      state.erasing = false;
      _eraserEl.style.display = 'none';
      if (state.didErase) {
        _save(pageNum, state);
        _notifyChange(pageNum);
      }
      state.didErase = false;
      return;
    }

    if (_currentTool === 'laser') {
      state.drawing = false;
      return;
    }

    if (!state.drawing) return;
    state.drawing = false;

    if (!state.currentStroke || !state.currentStroke.points.length) {
      state.currentStroke = null;
      _redraw(state);
      return;
    }

    _pushHistory(state);

    let finalizedStroke = state.currentStroke;
    if (_currentTool === 'shapes') {
      finalizedStroke = _snapShape(state.currentStroke);
    }

    state.strokes.push(finalizedStroke);
    state.currentStroke = null;
    _redraw(state);
    _save(pageNum, state);
    _notifyChange(pageNum);
  }

  function _drawFreehand(ctx, state, stroke) {
    const points = stroke.points || [];
    if (!points.length) return;

    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = _strokeWidthPx(stroke, state);
    ctx.globalAlpha = typeof stroke.alpha === 'number' ? stroke.alpha : 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = stroke.tool === 'highlighter' ? 'multiply' : 'source-over';

    if (points.length === 1) {
      const single = _toCanvasPoint(state, points[0]);
      ctx.arc(single.x, single.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
      return;
    }

    const first = _toCanvasPoint(state, points[0]);
    ctx.moveTo(first.x, first.y);

    for (let i = 1; i < points.length - 1; i += 1) {
      const current = _toCanvasPoint(state, points[i]);
      const next = _toCanvasPoint(state, points[i + 1]);
      const midpoint = {
        x: (current.x + next.x) / 2,
        y: (current.y + next.y) / 2
      };
      ctx.quadraticCurveTo(current.x, current.y, midpoint.x, midpoint.y);
    }

    const last = _toCanvasPoint(state, points[points.length - 1]);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  function _drawShape(ctx, state, stroke) {
    const start = stroke.start || stroke.points?.[0];
    const end = stroke.end || stroke.points?.[stroke.points.length - 1];
    if (!start || !end) return;

    const a = _toCanvasPoint(state, start);
    const b = _toCanvasPoint(state, end);
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const width = Math.abs(b.x - a.x);
    const height = Math.abs(b.y - a.y);

    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = _strokeWidthPx(stroke, state);
    ctx.globalAlpha = typeof stroke.alpha === 'number' ? stroke.alpha : 1;
    ctx.globalCompositeOperation = 'source-over';

    if (stroke.shape === 'rect') {
      ctx.strokeRect(left, top, width, height);
      return;
    }

    if (stroke.shape === 'ellipse') {
      ctx.ellipse(left + width / 2, top + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function _drawText(ctx, state, stroke) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = stroke.color || '#111111';
    ctx.font = `${_fontSizePx(stroke, state)}px 'Caveat', cursive`;
    ctx.textBaseline = 'top';
    const point = _toCanvasPoint(state, stroke);

    const lines = String(stroke.text || '').split('\n');
    const lineHeight = _fontSizePx(stroke, state) * 1.08;
    lines.forEach((line, index) => {
      ctx.fillText(line, point.x, point.y + (index * lineHeight));
    });
  }

  function _drawStroke(ctx, state, stroke) {
    if (!stroke) return;

    if (stroke.tool === 'text') {
      _drawText(ctx, state, stroke);
      return;
    }

    if (stroke.tool === 'shape' || stroke.tool === 'shape-preview') {
      _drawShape(ctx, state, stroke);
      return;
    }

    _drawFreehand(ctx, state, stroke);
  }

  function _redraw(state, previewStroke = null) {
    const { ctx, canvas, strokes } = state;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    strokes.forEach((stroke) => _drawStroke(ctx, state, stroke));
    if (previewStroke) {
      _drawStroke(ctx, state, previewStroke);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function _showEraser(e, state) {
    const size = Math.max(_strokeSize * 6, 18);
    _eraserEl.style.display = 'block';
    _eraserEl.style.width = `${size}px`;
    _eraserEl.style.height = `${size}px`;
    _eraserEl.style.left = `${e.clientX}px`;
    _eraserEl.style.top = `${e.clientY}px`;
  }

  function _showLaser(e) {
    if (!_laserEl) return;
    _laserEl.classList.remove('hidden');
    _laserEl.style.left = `${e.clientX}px`;
    _laserEl.style.top = `${e.clientY}px`;
  }

  function _hideLaser() {
    if (_laserEl) {
      _laserEl.classList.add('hidden');
    }
  }

  function _distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt((dx * dx) + (dy * dy));
  }

  function _distanceToLine(point, start, end) {
    const length = _distance(start, end) || 0.0001;
    return Math.abs(
      ((end.y - start.y) * point.x) -
      ((end.x - start.x) * point.y) +
      (end.x * start.y) -
      (end.y * start.x)
    ) / length;
  }

  function _shapeBounds(points) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys)
    };
  }

  function _previewShape(stroke) {
    if (!stroke?.points?.length) return stroke;
    const snapped = _snapShape(stroke);
    return snapped || stroke;
  }

  function _snapShape(stroke) {
    const points = stroke.points || [];
    if (points.length < 2) {
      return {
        ...stroke,
        tool: 'shape',
        shape: 'line',
        start: points[0],
        end: points[0]
      };
    }

    const start = points[0];
    const end = points[points.length - 1];
    const bounds = _shapeBounds(points);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const closed = _distance(start, end) < 0.05;

    const avgLineDistance = points.reduce((sum, point) => (
      sum + _distanceToLine(point, start, end)
    ), 0) / points.length;

    let shape = 'line';

    if (closed) {
      const edgeHits = points.filter((point) => (
        Math.abs(point.x - bounds.minX) < 0.02 ||
        Math.abs(point.x - bounds.maxX) < 0.02 ||
        Math.abs(point.y - bounds.minY) < 0.02 ||
        Math.abs(point.y - bounds.maxY) < 0.02
      )).length / points.length;

      const center = {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2
      };
      const radiusSamples = points.map((point) => _distance(point, center));
      const avgRadius = radiusSamples.reduce((sum, radius) => sum + radius, 0) / radiusSamples.length;
      const radiusVariance = radiusSamples.reduce((sum, radius) => (
        sum + Math.abs(radius - avgRadius)
      ), 0) / radiusSamples.length;

      if (edgeHits > 0.7 && Math.max(width, height) > 0.04) {
        shape = 'rect';
      } else if (radiusVariance < 0.018 && avgRadius > 0.03) {
        shape = 'ellipse';
      } else {
        shape = width > 0.03 && height > 0.03 ? 'rect' : 'line';
      }
    } else if (avgLineDistance < 0.012) {
      shape = 'line';
    } else {
      shape = width > 0.03 && height > 0.03 ? 'ellipse' : 'line';
    }

    return {
      tool: 'shape',
      shape,
      units: 'normalized',
      color: stroke.color,
      alpha: 1,
      sizeRatio: stroke.sizeRatio,
      start: shape === 'line'
        ? start
        : { x: bounds.minX, y: bounds.minY },
      end: shape === 'line'
        ? end
        : { x: bounds.maxX, y: bounds.maxY }
    };
  }

  function _eraseAt(point, pageNum, state) {
    const radius = Math.max(0.015, (_strokeSize * 6) / _pageWidth(state));
    const next = state.strokes.filter((stroke) => {
      if (stroke.tool === 'text') {
        return _distance(point, stroke) > radius;
      }

      if (stroke.tool === 'shape') {
        const start = stroke.start || stroke.points?.[0];
        const end = stroke.end || stroke.points?.[stroke.points.length - 1];
        if (!start || !end) return true;
        return _distance(point, start) > radius && _distance(point, end) > radius;
      }

      return !(stroke.points || []).some((strokePoint) => _distance(point, strokePoint) < radius);
    });

    const changed = next.length !== state.strokes.length;
    if (!changed) return;

    if (!state.erasing) {
      _pushHistory(state);
      state.erasing = true;
    }

    state.strokes = next;
    state.didErase = true;
    _redraw(state);
  }

  function _placeText(e, pageNum, state) {
    const point = _fromPointer(e, state.canvas);
    const rect = state.canvas.getBoundingClientRect();
    const textarea = document.getElementById('floating-text');
    const fontPx = Math.max(18, _strokeSize * 4);

    textarea.style.left = `${rect.left + (point.x * rect.width)}px`;
    textarea.style.top = `${rect.top + (point.y * rect.height)}px`;
    textarea.style.color = _currentColor;
    textarea.style.fontSize = `${fontPx}px`;
    textarea.value = '';
    textarea.classList.remove('hidden');
    textarea.focus();

    const commit = () => {
      const text = textarea.value.trim();
      textarea.classList.add('hidden');
      textarea.removeEventListener('blur', commit);
      textarea.removeEventListener('keydown', onKey);

      if (!text) return;

      _pushHistory(state);
      state.strokes.push({
        tool: 'text',
        units: 'normalized',
        color: _currentColor,
        fontRatio: fontPx / _pageWidth(state),
        text,
        x: point.x,
        y: point.y
      });
      _redraw(state);
      _save(pageNum, state);
      _notifyChange(pageNum);
    };

    const onKey = (event) => {
      if (event.key === 'Escape') {
        textarea.classList.add('hidden');
        textarea.removeEventListener('blur', commit);
        textarea.removeEventListener('keydown', onKey);
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        commit();
      }
    };

    textarea.addEventListener('blur', commit, { once: true });
    textarea.addEventListener('keydown', onKey);
  }

  function _save(pageNum, state) {
    if (_docId) {
      Storage.save(_docId, pageNum, state.strokes);
    }
  }

  function setTool(tool) {
    _currentTool = tool;

    document.querySelectorAll('.page-wrapper').forEach((wrapper) => {
      wrapper.classList.remove(
        'drawing-active',
        'eraser-active',
        'text-active',
        'shape-active',
        'laser-active'
      );

      if (tool === 'pen' || tool === 'highlighter') wrapper.classList.add('drawing-active');
      if (tool === 'eraser') wrapper.classList.add('eraser-active');
      if (tool === 'text') wrapper.classList.add('text-active');
      if (tool === 'shapes') wrapper.classList.add('shape-active');
      if (tool === 'laser') wrapper.classList.add('laser-active');
    });

    if (tool !== 'eraser') {
      _eraserEl.style.display = 'none';
    }
    if (tool !== 'laser') {
      _hideLaser();
    }
  }

  function setColor(color) {
    _currentColor = color;
  }

  function setStrokeSize(size) {
    _strokeSize = size;
  }

  function setDocId(id) {
    _docId = id;
  }

  function setOnChange(handler) {
    _onChange = handler;
  }

  function resetPages() {
    _pages.clear();
    _eraserEl.style.display = 'none';
    _hideLaser();
  }

  function clearCurrentPage(pageNum) {
    const state = _currentPageState(pageNum);
    if (!state || !state.strokes.length) return false;

    _pushHistory(state);
    state.strokes = [];
    _redraw(state);
    Storage.clearPage(_docId, pageNum);
    _notifyChange(pageNum);
    return true;
  }

  function undo(pageNum) {
    const state = _currentPageState(pageNum);
    if (!state || !state.undoStack.length) return false;

    state.redoStack.push(_clone(state.strokes));
    state.strokes = state.undoStack.pop();
    _redraw(state);
    _save(pageNum, state);
    _notifyChange(pageNum);
    return true;
  }

  function redo(pageNum) {
    const state = _currentPageState(pageNum);
    if (!state || !state.redoStack.length) return false;

    state.undoStack.push(_clone(state.strokes));
    state.strokes = state.redoStack.pop();
    _redraw(state);
    _save(pageNum, state);
    _notifyChange(pageNum);
    return true;
  }

  function canUndo(pageNum) {
    return (_currentPageState(pageNum)?.undoStack.length || 0) > 0;
  }

  function canRedo(pageNum) {
    return (_currentPageState(pageNum)?.redoStack.length || 0) > 0;
  }

  function pageHasContent(pageNum) {
    return (_currentPageState(pageNum)?.strokes.length || 0) > 0;
  }

  function renderPageToCanvas(pageNum, width, height) {
    const sourceState = _currentPageState(pageNum);
    const strokes = sourceState ? _clone(sourceState.strokes) : _restoreStrokes(pageNum, width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    const state = {
      canvas,
      ctx,
      strokes,
      pageNum
    };

    _redraw(state);
    return canvas;
  }

  function getTool() {
    return _currentTool;
  }

  return {
    initPage,
    setTool,
    setColor,
    setStrokeSize,
    setDocId,
    setOnChange,
    resetPages,
    clearCurrentPage,
    undo,
    redo,
    canUndo,
    canRedo,
    pageHasContent,
    renderPageToCanvas,
    getTool
  };
})();
