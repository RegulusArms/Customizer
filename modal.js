(function () {
// Small promise-based modal helpers (info / confirm / progress) shared by the editor and app.

const overlay = document.getElementById('modalOverlay');
const box = document.getElementById('modalBox');
const messageEl = document.getElementById('modalMessage');
const extraEl = document.getElementById('modalExtra');
const actionsEl = document.getElementById('modalActions');
const cancelBtn = document.getElementById('modalCancelBtn');
const okBtn = document.getElementById('modalOkBtn');

// Modals are queued so a second request waits for the first to be dismissed.
let chain = Promise.resolve();

function open(message, { okLabel = 'OK', cancelLabel = 'Cancel', showCancel = false, extra = null, wide = false } = {}) {
  const run = () => new Promise(resolve => {
    messageEl.textContent = message;
    extraEl.innerHTML = '';
    if (extra) extraEl.appendChild(extra);
    box.classList.toggle('modal-wide', wide);
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    cancelBtn.style.display = showCancel ? '' : 'none';
    actionsEl.style.display = '';
    overlay.style.display = 'flex';
    okBtn.focus();
    const finish = value => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey, true);
      overlay.style.display = 'none';
      extraEl.innerHTML = '';
      box.classList.remove('modal-wide');
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, true);
  });
  const p = chain.then(run);
  chain = p.catch(() => {});
  return p;
}

function showInfo(message, okLabel) {
  return open(message, { okLabel });
}

function showConfirm(message, okLabel = 'OK', cancelLabel = 'Cancel') {
  return open(message, { okLabel, cancelLabel, showCancel: true });
}

function showImage(message, url) {
  const wrap = document.createElement('div');
  wrap.className = 'export-mockup-grid';
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'Front render';
  wrap.appendChild(img);
  return open(message, { extra: wrap });
}

// A non-dismissible progress bar for multi-second work; call close() when done.
function showProgress(label) {
  const track = document.createElement('div');
  track.className = 'export-progress-track';
  const fill = document.createElement('div');
  fill.className = 'export-progress-fill';
  track.appendChild(fill);
  messageEl.textContent = label;
  extraEl.innerHTML = '';
  extraEl.appendChild(track);
  actionsEl.style.display = 'none';
  overlay.style.display = 'flex';
  return {
    update(fraction, text) {
      fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      if (text != null) messageEl.textContent = text;
    },
    close() {
      overlay.style.display = 'none';
      actionsEl.style.display = '';
      extraEl.innerHTML = '';
    },
  };
}

window.KCModal = { showInfo, showConfirm, showImage, showProgress };
})();
