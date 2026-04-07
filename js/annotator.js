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
  let _laserHideTimer = null;

  const LASER_IDLE_MS = 120;
  const LASER_FADE_DELAY_MS = 180;
  const LASER_FADE_MS = 780;
  const MAX_PIXEL_RATIO = 2;

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
    return state.renderWidth || state.canvas.width || 1;
  }

  function _pageHeight(state) {
    return state.renderHeight || state.canvas.height || 1;
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
      y: _clamp01((e.clientY - rect.top) / rect.height),
      pressure: _pointerPressure(e)
    };
  }

  function _pointerPressure(event) {
    if (event.pointerType === 'mouse') return 0.58;
    if (typeof event.pressure === 'number' && event.pressure > 0) {
      return Math.max(0.22, Math.min(1, event.pressure));
    }
    return 0.6;
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
            y: _clamp01((point.y || 0) / safeHeight),
            pressure: typeof point.pressure === 'number'
              ? Math.max(0.22, Math.min(1, point.pressure))
              : undefined
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
    const pixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.imageSmoothingEnabled = true;

    const strokes = _restoreStrokes(pageNum, width, height);
    const state = {
      pageNum,
      canvas,
      ctx,
      renderWidth: width,
      renderHeight: height,
      pixelRatio,
      strokes,
      drawing: false,
      currentStroke: null,
      undoStack: [],
      redoStack: [],
      erasing: false,
      laserStrokes: [],
      activeLaserStroke: null,
      laserAnimationFrame: 0
    };

    _pages.set(pageNum, state);
    _redraw(state);

    canvas.addEventListener('pointerdown', (e) => _onDown(e, pageNum, state));
    canvas.addEventListener('pointermove', (e) => _onMove(e, pageNum, state));
    canvas.addEventListener('pointerup', (e) => _onUp(e, pageNum, state));
    canvas.addEventListener('pointercancel', (e) => _onUp(e, pageNum, state));
    canvas.addEventListener('pointerleave', () => {
      if (_currentTool === 'laser' && !state.drawing) {
        _scheduleLaserHide(40);
      }
      if (_currentTool !== 'eraser' || !state.drawing) {
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
    state.canvas.setPointerCapture?.(e.pointerId);

    if (_currentTool === 'laser') {
      state.activeLaserStroke = {
        points: [_fromPointer(e, state.canvas)]
      };
      _showLaser(e);
      _redraw(state);
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
      alpha: isHighlighter ? 0.22 : 0.98,
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
      if (state.drawing && state.activeLaserStroke) {
        _pushPoint(state.activeLaserStroke.points, _fromPointer(e, state.canvas), state);
        _redraw(state);
      }
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

    _pushPoint(state.currentStroke.points, _fromPointer(e, state.canvas), state);
    _redraw(state, _currentTool === 'shapes'
      ? _previewShape(state.currentStroke)
      : state.currentStroke);
  }

  function _onUp(e, pageNum, state) {
    if (e?.pointerId != null && state.canvas.hasPointerCapture?.(e.pointerId)) {
      state.canvas.releasePointerCapture(e.pointerId);
    }

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
      if (state.activeLaserStroke?.points?.length) {
        const now = performance.now();
        state.laserStrokes.push({
          points: state.activeLaserStroke.points,
          fadeStart: now + LASER_FADE_DELAY_MS,
          removeAt: now + LASER_FADE_DELAY_MS + LASER_FADE_MS
        });
        state.activeLaserStroke = null;
        _queueLaserAnimation(state);
        _redraw(state);
      }
      _scheduleLaserHide(60);
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

  function _pushPoint(points, point, state) {
    const last = points[points.length - 1];
    if (!last) {
      points.push(point);
      return;
    }

    const minDistance = Math.max(0.0012, 0.8 / _pageWidth(state));
    if (_distance(last, point) < minDistance) {
      last.pressure = (last.pressure + point.pressure) / 2;
      return;
    }

    points.push(point);
  }

  function _strokeSegmentWidth(stroke, state, startPoint, endPoint) {
    const baseWidth = _strokeWidthPx(stroke, state);
    if (stroke.tool !== 'pen') return baseWidth;

    const pressure = (
      (typeof startPoint.pressure === 'number' ? startPoint.pressure : 0.58) +
      (typeof endPoint.pressure === 'number' ? endPoint.pressure : 0.58)
    ) / 2;
    const distancePx = _distance(
      _toCanvasPoint(state, startPoint),
      _toCanvasPoint(state, endPoint)
    );
    const speedFactor = Math.min(1, distancePx / 22);

    return Math.max(1.2, baseWidth * (0.82 + (pressure * 0.32) - (speedFactor * 0.08)));
  }

  function _drawSmoothedStroke(ctx, state, stroke, widthResolver) {
    const points = stroke.points || [];
    if (!points.length) return;

    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.globalAlpha = typeof stroke.alpha === 'number' ? stroke.alpha : 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (points.length === 1) {
      const single = _toCanvasPoint(state, points[0]);
      const dotSize = widthResolver(points[0], points[0]);
      ctx.beginPath();
      ctx.arc(single.x, single.y, dotSize / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const logicalPoints = points.map((point) => ({
      x: point.x * _pageWidth(state),
      y: point.y * _pageHeight(state),
      pressure: point.pressure
    }));

    let previousAnchor = logicalPoints[0];
    let previousMidpoint = previousAnchor;

    for (let i = 1; i < logicalPoints.length; i += 1) {
      const currentPoint = logicalPoints[i];
      const midpoint = {
        x: (previousAnchor.x + currentPoint.x) / 2,
        y: (previousAnchor.y + currentPoint.y) / 2
      };

      ctx.beginPath();
      ctx.lineWidth = widthResolver(points[i - 1], points[i]);
      ctx.moveTo(previousMidpoint.x, previousMidpoint.y);
      ctx.quadraticCurveTo(previousAnchor.x, previousAnchor.y, midpoint.x, midpoint.y);
      ctx.stroke();

      previousMidpoint = midpoint;
      previousAnchor = currentPoint;
    }

    const lastSource = points[points.length - 1];
    const lastWidth = widthResolver(lastSource, lastSource);
    ctx.beginPath();
    ctx.lineWidth = lastWidth;
    ctx.moveTo(previousMidpoint.x, previousMidpoint.y);
    ctx.lineTo(previousAnchor.x, previousAnchor.y);
    ctx.stroke();
  }

  function _drawFreehand(ctx, state, stroke) {
    ctx.globalCompositeOperation = stroke.tool === 'highlighter' ? 'multiply' : 'source-over';
    _drawSmoothedStroke(
      ctx,
      state,
      stroke,
      (startPoint, endPoint) => _strokeSegmentWidth(stroke, state, startPoint, endPoint)
    );
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
    ctx.save();
    ctx.setTransform(state.pixelRatio || 1, 0, 0, state.pixelRatio || 1, 0, 0);
    ctx.clearRect(0, 0, _pageWidth(state), _pageHeight(state));

    strokes.forEach((stroke) => _drawStroke(ctx, state, stroke));
    if (previewStroke) {
      _drawStroke(ctx, state, previewStroke);
    }
    _drawLaserStrokes(ctx, state);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
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
    clearTimeout(_laserHideTimer);
    _laserEl.classList.add('visible');
    _laserEl.style.left = `${e.clientX}px`;
    _laserEl.style.top = `${e.clientY}px`;
    _laserHideTimer = setTimeout(() => {
      if (!Array.from(_pages.values()).some((state) => state.drawing && _currentTool === 'laser')) {
        _hideLaser();
      }
    }, LASER_IDLE_MS);
  }

  function _hideLaser() {
    if (_laserEl) {
      clearTimeout(_laserHideTimer);
      _laserEl.classList.remove('visible');
    }
  }

  function _scheduleLaserHide(delay = LASER_IDLE_MS) {
    clearTimeout(_laserHideTimer);
    _laserHideTimer = setTimeout(() => _hideLaser(), delay);
  }

  function _drawLaserStrokes(ctx, state) {
    const now = performance.now();
    const visibleStrokes = [];

    if (state.activeLaserStroke?.points?.length) {
      visibleStrokes.push({
        points: state.activeLaserStroke.points,
        alpha: 0.94
      });
    }

    state.laserStrokes = state.laserStrokes.filter((stroke) => now < stroke.removeAt);

    state.laserStrokes.forEach((stroke) => {
      const alpha = now < stroke.fadeStart
        ? 0.9
        : Math.max(0, 0.9 * (1 - ((now - stroke.fadeStart) / LASER_FADE_MS)));
      if (alpha > 0.01) {
        visibleStrokes.push({
          points: stroke.points,
          alpha
        });
      }
    });

    visibleStrokes.forEach((stroke) => {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.strokeStyle = `rgba(255, 74, 74, ${stroke.alpha})`;
      ctx.fillStyle = `rgba(255, 90, 90, ${stroke.alpha})`;
      ctx.shadowColor = `rgba(255, 70, 70, ${Math.min(1, stroke.alpha + 0.05)})`;
      ctx.shadowBlur = 16;
      _drawSmoothedStroke(
        ctx,
        state,
        {
          tool: 'laser',
          points: stroke.points,
          color: '#ff4a4a',
          alpha: stroke.alpha,
          sizeRatio: 7 / _pageWidth(state)
        },
        () => 6.5
      );
      ctx.restore();
    });
  }

  function _queueLaserAnimation(state) {
    if (state.laserAnimationFrame) return;

    const tick = () => {
      state.laserAnimationFrame = 0;
      const now = performance.now();
      const hasMoreLaser = state.laserStrokes.some((stroke) => now < stroke.removeAt);
      _redraw(state);

      if (hasMoreLaser || state.activeLaserStroke) {
        state.laserAnimationFrame = requestAnimationFrame(tick);
      }
    };

    state.laserAnimationFrame = requestAnimationFrame(tick);
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
    _pages.forEach((state) => {
      if (state.laserAnimationFrame) {
        cancelAnimationFrame(state.laserAnimationFrame);
      }
    });
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
      pageNum,
      renderWidth: width,
      renderHeight: height,
      pixelRatio: 1,
      laserStrokes: [],
      activeLaserStroke: null
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
