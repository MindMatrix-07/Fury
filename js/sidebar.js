/* ─── sidebar.js ───
   Renders page thumbnails and keeps the active page in sync
   with the viewer scroll position.
*/

const Sidebar = (() => {
  let _pdfDoc = null;
  let _viewer = null;
  let _current = 1;
  let _pageObserver = null;

  async function render(pdfDoc, viewerWrap) {
    _pdfDoc = pdfDoc;
    _viewer = viewerWrap;
    _current = 1;

    const list = document.getElementById('thumb-list');
    list.innerHTML = '';

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum += 1) {
      const item = document.createElement('div');
      item.className = `thumb-item${pageNum === 1 ? ' active' : ''}`;
      item.dataset.page = pageNum;

      const canvas = document.createElement('canvas');
      canvas.className = 'thumb-canvas';
      item.appendChild(canvas);

      const number = document.createElement('span');
      number.className = 'thumb-num';
      number.textContent = pageNum;
      item.appendChild(number);

      item.addEventListener('click', () => scrollTo(pageNum));
      list.appendChild(item);

      _renderThumb(pageNum, canvas);
    }
  }

  async function _renderThumb(pageNum, canvas) {
    try {
      const page = await _pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 0.22 });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);

      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport
      }).promise;
    } catch (error) {
      // Skip broken thumbnail renders and keep the viewer usable.
    }
  }

  function scrollTo(pageNum, behavior = 'smooth') {
    const target = document.querySelector(`.page-wrapper[data-page="${pageNum}"]`);
    if (target) {
      target.scrollIntoView({
        behavior: behavior === 'instant' ? 'auto' : behavior,
        block: 'start'
      });
    }
    setActive(pageNum);
  }

  function setActive(pageNum) {
    _current = pageNum;
    document.querySelectorAll('.thumb-item').forEach((item) => {
      item.classList.toggle('active', parseInt(item.dataset.page, 10) === pageNum);
    });

    document.getElementById('page-current').textContent = pageNum;
  }

  function observePages(onPageChange) {
    if (_pageObserver) {
      _pageObserver.disconnect();
    }

    _pageObserver = new IntersectionObserver((entries) => {
      let bestTarget = null;
      let bestRatio = 0;

      entries.forEach((entry) => {
        if (entry.intersectionRatio > bestRatio) {
          bestRatio = entry.intersectionRatio;
          bestTarget = entry.target;
        }
      });

      if (!bestTarget) return;

      const pageNum = parseInt(bestTarget.dataset.page, 10);
      if (!Number.isFinite(pageNum)) return;

      if (pageNum !== _current) {
        setActive(pageNum);
        const thumbItem = document.querySelector(`.thumb-item[data-page="${pageNum}"]`);
        if (thumbItem) {
          thumbItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }

      if (typeof onPageChange === 'function') {
        onPageChange(pageNum);
      }
    }, {
      threshold: [0.3, 0.55, 0.85],
      root: document.getElementById('viewer-wrap')
    });

    document.querySelectorAll('.page-wrapper').forEach((pageWrapper) => {
      _pageObserver.observe(pageWrapper);
    });
  }

  return {
    render,
    scrollTo,
    setActive,
    observePages
  };
})();
