/* ===========================================================
   הגדרות
   =========================================================== */
const CONFIG = {
  // TODO: הדבק כאן את כתובת ה-Web App שקיבלת מפריסת Code.gs (מסתיימת ב-/exec)
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwgtgNFfbynR-v5xjR-5Ug6i0ddxJfCs9S6EA1q5OeHZDWUEmYSbAfqJvRgG6YkLloE/exec',
  GOOGLE_CLIENT_ID: '1087997271039-b8l9oi9mcut6vkp9trdmobgm78fgolme.apps.googleusercontent.com'
};

/* ===========================================================
   מצב
   =========================================================== */
const state = {
  key: localStorage.getItem('crit_key') || '',
  name: localStorage.getItem('crit_name') || '',
  picture: localStorage.getItem('crit_picture') || '',
};

let allItems = {};          // itemId -> item (כולל ביקורות, נטען פעם אחת ומעודכן לאחר כל פעולה)
let itemOrder = [];         // סדר הצגה בפיד
let currentOpenItemId = null;
let currentStars = 0;

let pendingImages = [];       // תמונות עבור יצירת פריט חדש
let pendingReviewImages = []; // תמונות עבור ביקורת

/* ===========================================================
   עזר: קריאות לשרת
   =========================================================== */
async function api(action, payload) {
  if (!CONFIG.APPS_SCRIPT_URL) {
    showToast('חסרה כתובת שרת: יש להדביק את ה-URL של הפריסה בתוך app.js (משתנה APPS_SCRIPT_URL)', true);
    throw new Error('APPS_SCRIPT_URL not set');
  }
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
    method: 'POST',
    // text/plain כדי להימנע מ-CORS preflight מול Apps Script (שלא תומך ב-OPTIONS)
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action: action }, payload || {}))
  });
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

function showToast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('toast-error', !!isError);
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ===========================================================
   התחברות עם Google
   =========================================================== */
function waitForGoogleSdk(cb) {
  if (window.google && window.google.accounts && window.google.accounts.id) return cb();
  setTimeout(() => waitForGoogleSdk(cb), 120);
}

function initGoogleAuth() {
  waitForGoogleSdk(() => {
    google.accounts.id.initialize({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      callback: handleCredentialResponse
    });
    renderAuthArea();
  });
}

async function handleCredentialResponse(response) {
  try {
    const data = await api('login', { idToken: response.credential });
    state.key = data.key;
    state.name = data.name || '';
    state.picture = data.picture || '';
    localStorage.setItem('crit_key', state.key);
    localStorage.setItem('crit_name', state.name);
    localStorage.setItem('crit_picture', state.picture);
    renderAuthArea();
    showToast('התחברת בהצלחה, ברוך/ה הבא/ה ' + (state.name || ''));
    await loadAllData();
  } catch (err) {
    showToast('ההתחברות נכשלה: ' + err.message, true);
  }
}

function signOut() {
  state.key = ''; state.name = ''; state.picture = '';
  localStorage.removeItem('crit_key');
  localStorage.removeItem('crit_name');
  localStorage.removeItem('crit_picture');
  if (window.google && google.accounts && google.accounts.id) {
    google.accounts.id.disableAutoSelect();
  }
  renderAuthArea();
  showToast('התנתקת');
  loadAllData();
}

function renderAuthArea() {
  const area = document.getElementById('auth-area');
  if (state.key) {
    area.innerHTML = '';
    const chip = document.createElement('div');
    chip.className = 'user-chip';
    chip.innerHTML =
      (state.picture ? '<img src="' + escapeAttr(state.picture) + '" alt="" referrerpolicy="no-referrer">' : '') +
      '<span>' + escapeHtml(state.name || 'משתמש') + '</span>' +
      '<button class="signout" id="btn-signout">התנתק</button>';
    area.appendChild(chip);
    document.getElementById('btn-signout').addEventListener('click', signOut);
  } else {
    area.innerHTML = '<div id="g_id_signin_container"></div>';
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.renderButton(
        document.getElementById('g_id_signin_container'),
        { theme: 'outline', size: 'large', shape: 'pill', locale: 'he', text: 'signin_with' }
      );
    }
  }
}

/* ===========================================================
   טעינה מלאה - פריטים + ביקורות + לייקים, הכל בבת אחת
   =========================================================== */
async function loadAllData() {
  const loadingEl = document.getElementById('feed-loading');
  try {
    const data = await api('getAllData', { key: state.key || '' });
    allItems = {};
    itemOrder = [];
    (data.items || []).forEach(item => {
      allItems[item.itemId] = item;
      itemOrder.push(item.itemId);
    });
    loadingEl.hidden = true;
    renderFeed();
    // אם מודל פריט פתוח כרגע - מרעננים אותו עם הנתונים המעודכנים
    if (currentOpenItemId && allItems[currentOpenItemId]) {
      renderItemDetail(allItems[currentOpenItemId]);
    }
  } catch (err) {
    loadingEl.textContent = 'שגיאה בטעינת הנתונים: ' + err.message;
  }
}

/* ===========================================================
   טבעת דירוג (Rating Ring) - האלמנט החזותי המרכזי
   =========================================================== */
function ratingRingHtml(avg, count, size) {
  size = size || 46;
  if (!count) {
    return '<span class="rating-ring-empty">אין עדיין ביקורות</span>';
  }
  const r = (size - 6) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, avg / 5));
  const offset = circumference * (1 - pct);
  const fontSize = size <= 46 ? 12 : 16;
  return (
    '<span class="rating-ring-wrap" title="דירוג ממוצע מתוך 5 כוכבים">' +
      '<svg class="rating-ring" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
        '<g transform="rotate(-90 ' + c + ' ' + c + ')">' +
          '<circle class="rating-ring-track" cx="' + c + '" cy="' + c + '" r="' + r + '" stroke-width="4"></circle>' +
          '<circle class="rating-ring-fill" cx="' + c + '" cy="' + c + '" r="' + r + '" stroke-width="4" ' +
            'stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '"></circle>' +
        '</g>' +
        '<text class="rating-ring-num" x="' + c + '" y="' + c + '" font-size="' + fontSize + '">' + avg.toFixed(1) + '</text>' +
      '</svg>' +
      '<span class="rating-ring-label">' + count + ' ביקורות</span>' +
    '</span>'
  );
}

/* ===========================================================
   פיד
   =========================================================== */
function renderFeed() {
  const grid = document.getElementById('feed-grid');
  const empty = document.getElementById('feed-empty');
  const count = document.getElementById('feed-count');
  const items = itemOrder.map(id => allItems[id]);

  count.textContent = items.length ? (items.length + ' עבודות') : '';
  grid.innerHTML = '';
  empty.hidden = items.length > 0;

  items.forEach(item => {
    const card = document.createElement('article');
    card.className = 'item-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const thumb = (item.images && item.images[0])
      ? '<img class="item-card-thumb" src="' + escapeAttr(item.images[0]) + '" alt="" referrerpolicy="no-referrer" loading="lazy">'
      : '';

    card.innerHTML =
      thumb +
      '<h3 class="item-card-title">' + escapeHtml(item.title) + '</h3>' +
      '<p class="item-card-desc">' + escapeHtml(item.description || '') + '</p>' +
      '<div class="item-card-footer">' +
        '<span class="item-card-owner">מאת ' + escapeHtml(item.ownerName || 'אלמוני') + '</span>' +
        ratingRingHtml(item.avgRating, item.reviewCount, 42) +
      '</div>';

    card.addEventListener('click', () => openItemDetail(item.itemId));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openItemDetail(item.itemId); });
    grid.appendChild(card);
  });
}

/* ===========================================================
   פרטי פריט + ביקורות (נטען כולו מהזיכרון - ללא בקשת רשת)
   =========================================================== */
function openItemDetail(itemId) {
  const item = allItems[itemId];
  if (!item) { showToast('הפריט לא נמצא', true); return; }
  currentOpenItemId = itemId;
  renderItemDetail(item);
  openModal('modal-item');
}

function renderItemDetail(item) {
  const el = document.getElementById('item-detail-content');

  const imagesHtml = (item.images && item.images.length)
    ? '<div class="detail-images">' + item.images.map(u => '<img src="' + escapeAttr(u) + '" alt="" referrerpolicy="no-referrer">').join('') + '</div>'
    : '';

  const linksHtml = (item.links && item.links.length)
    ? '<ul class="detail-links">' + item.links.map(l => '<li><a href="' + escapeAttr(l) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(l) + '</a></li>').join('') + '</ul>'
    : '';

  el.innerHTML =
    '<p class="detail-owner">הוגש על ידי ' + escapeHtml(item.ownerName || 'אלמוני') + '</p>' +
    '<h2 class="detail-title">' + escapeHtml(item.title) + '</h2>' +
    imagesHtml +
    '<p class="detail-desc">' + escapeHtml(item.description || '') + '</p>' +
    linksHtml +
    '<div class="detail-rating-summary">' + ratingRingHtml(item.avgRating, item.reviewCount, 56) + '</div>';

  // אזור כתיבת/עדכון ביקורת - אלמנטים סטטיים, רק מציגים/מסתירים ומעדכנים תוכן
  const reviewBox = document.getElementById('review-form-box');
  const signinNote = document.getElementById('signin-note');
  const ownerNote = document.getElementById('owner-note');
  reviewBox.hidden = true; signinNote.hidden = true; ownerNote.hidden = true;

  if (!state.key) {
    signinNote.hidden = false;
  } else if (item.isOwner) {
    ownerNote.hidden = false;
    document.getElementById('btn-delete-item').onclick = () => deleteItem(item.itemId);
  } else {
    reviewBox.hidden = false;
    const my = item.myReview || null;
    currentStars = my ? my.stars : 0;
    pendingReviewImages.length = 0;
    if (my && my.images) pendingReviewImages.push.apply(pendingReviewImages, my.images);
    document.getElementById('review-form-title').textContent = my ? 'עדכון הביקורת שלך' : 'כתיבת ביקורת';
    document.getElementById('review-comment').value = my ? (my.comment || '') : '';
    document.getElementById('btn-submit-review').textContent = my ? 'עדכן ביקורת' : 'שלח ביקורת';
    document.getElementById('review-error').hidden = true;
    renderStarPicker(currentStars);
    renderImagePreviews('review-image-previews', pendingReviewImages);
    const btn = document.getElementById('btn-submit-review');
    btn.disabled = false;
    btn.onclick = () => submitReview(item.itemId);
  }

  // רשימת ביקורות
  const reviews = item.reviews || [];
  document.getElementById('reviews-divider').hidden = false;
  const titleEl = document.getElementById('reviews-title');
  titleEl.hidden = false;
  titleEl.textContent = 'ביקורות (' + reviews.length + ')';
  document.getElementById('reviews-list').innerHTML = renderReviewsList(reviews);

  document.querySelectorAll('.like-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleLike(btn.dataset.reviewId));
  });
}

function renderReviewsList(reviews) {
  if (!reviews.length) return '<p class="reviews-empty">עדיין אין ביקורות על העבודה הזו.</p>';
  return reviews.map(r => {
    const stars = '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars);
    const time = r.createdAt ? new Date(r.createdAt).toLocaleDateString('he-IL') : '';
    const avatar = r.reviewerPicture
      ? '<img class="review-avatar" src="' + escapeAttr(r.reviewerPicture) + '" alt="" referrerpolicy="no-referrer">'
      : '<span class="review-avatar-fallback">' + escapeHtml((r.reviewerName || '?').charAt(0)) + '</span>';
    const imagesHtml = (r.images && r.images.length)
      ? '<div class="review-images">' + r.images.map(u => '<img src="' + escapeAttr(u) + '" alt="" referrerpolicy="no-referrer">').join('') + '</div>'
      : '';
    const likeBtn =
      '<button type="button" class="like-btn' + (r.myLiked ? ' liked' : '') + '" data-review-id="' + escapeAttr(r.reviewId) + '"' +
      (r.canLike ? '' : ' disabled title="לא ניתן לסמן לייק לביקורת שלך, או שצריך להתחבר"') + '>' +
        (r.myLiked ? '♥' : '♡') + (r.likeCount ? ' ' + r.likeCount : '') +
      '</button>';

    return (
      '<div class="review-item">' +
        '<div class="review-item-head">' +
          avatar +
          '<div class="review-head-text">' +
            '<span class="review-author">' + escapeHtml(r.reviewerName || 'אלמוני') + '</span>' +
            '<span class="review-time">' + time + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="review-stars">' + stars + '</div>' +
        (r.comment ? '<p class="review-comment">' + escapeHtml(r.comment) + '</p>' : '') +
        imagesHtml +
        likeBtn +
      '</div>'
    );
  }).join('');
}

/* ===========================================================
   בוחר כוכבים - מבוסס JS (לא CSS ~) כדי שההדגשה תמיד תואם לבחירה, גם ב-RTL
   =========================================================== */
function renderStarPicker(selected) {
  const box = document.getElementById('star-picker');
  box.innerHTML = '';
  const buttons = [];
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.value = String(i);
    buttons.push(b);
    box.appendChild(b);
  }
  function paint(upto) {
    buttons.forEach((b, idx) => {
      const val = idx + 1;
      b.textContent = val <= upto ? '★' : '☆';
      b.classList.toggle('active', val <= upto);
    });
  }
  buttons.forEach(b => {
    b.addEventListener('mouseenter', () => paint(Number(b.dataset.value)));
    b.addEventListener('click', () => { currentStars = Number(b.dataset.value); paint(currentStars); });
  });
  box.addEventListener('mouseleave', () => paint(currentStars));
  paint(selected);
}

async function submitReview(itemId) {
  const errEl = document.getElementById('review-error');
  errEl.hidden = true;
  if (!currentStars) {
    errEl.textContent = 'יש לבחור דירוג בכוכבים לפני השליחה';
    errEl.hidden = false;
    return;
  }
  const comment = document.getElementById('review-comment').value.trim();
  const btn = document.getElementById('btn-submit-review');
  btn.disabled = true;
  try {
    await api('addReview', {
      key: state.key, itemId: itemId, stars: currentStars, comment: comment, images: pendingReviewImages
    });
    showToast('הביקורת נשלחה, תודה!');
    await loadAllData();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function toggleLike(reviewId) {
  if (!state.key) { showToast('צריך להתחבר עם Google כדי לסמן לייק', true); return; }
  try {
    await api('toggleLike', { key: state.key, reviewId: reviewId });
    await loadAllData();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function deleteItem(itemId) {
  if (!confirm('למחוק את העבודה? הפעולה בלתי הפיכה, וכל הביקורות עליה יימחקו גם כן.')) return;
  try {
    await api('deleteItem', { key: state.key, itemId: itemId });
    showToast('העבודה נמחקה');
    closeModal('modal-item');
    await loadAllData();
  } catch (err) {
    showToast(err.message, true);
  }
}

/* ===========================================================
   יצירת פריט חדש
   =========================================================== */
function addLinkRow(value) {
  const list = document.getElementById('links-list');
  if (list.children.length >= 5) return;
  const row = document.createElement('div');
  row.className = 'link-row';
  row.innerHTML =
    '<input class="field-input" type="url" placeholder="https://..." value="' + escapeAttr(value || '') + '">' +
    '<button type="button" aria-label="הסר קישור">✕</button>';
  row.querySelector('button').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

function collectLinks() {
  return Array.from(document.querySelectorAll('#links-list input'))
    .map(i => i.value.trim())
    .filter(Boolean);
}

/* ===========================================================
   תצוגה מקדימה כללית לתמונות (משמש גם ליצירת פריט וגם לביקורת)
   =========================================================== */
function renderImagePreviews(containerId, imagesArray) {
  const box = document.getElementById(containerId);
  box.innerHTML = imagesArray.map((url, idx) =>
    '<div class="image-preview">' +
      '<img src="' + escapeAttr(url) + '" alt="" referrerpolicy="no-referrer">' +
      '<button type="button" data-idx="' + idx + '" aria-label="הסר תמונה">✕</button>' +
    '</div>'
  ).join('');
  box.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      imagesArray.splice(Number(btn.dataset.idx), 1);
      renderImagePreviews(containerId, imagesArray);
    });
  });
}

// ה-widget של imgbb כותב HTML (data-auto-insert="html-embed-full") לתוך הטקסטאריה המוסתרת
// המתאימה, לכל תמונה שהועלתה. שולפים משם את כתובות ה-URL ומרוקנים את הטקסטאריה
// כדי שהעלאה הבאה תתחיל נקי.
function setupImageWatcher(textareaId, imagesArray, previewsContainerId) {
  const ta = document.getElementById(textareaId);
  if (!ta) return;
  ta.addEventListener('input', () => {
    const matches = ta.value.matchAll(/<img[^>]*\ssrc=["']([^"']+)["']/gi);
    let added = false;
    for (const m of matches) {
      if (m[1] && !imagesArray.includes(m[1])) { imagesArray.push(m[1]); added = true; }
    }
    ta.value = '';
    renderImagePreviews(previewsContainerId, imagesArray);
    if (added) {
      showToast('התמונה נוספה בהצלחה');
      window.focus();
    }
  });
}

function resetCreateForm() {
  document.getElementById('create-form').reset();
  document.getElementById('links-list').innerHTML = '';
  addLinkRow('');
  pendingImages.length = 0;
  renderImagePreviews('image-previews', pendingImages);
  document.getElementById('create-error').hidden = true;
}

async function submitCreateForm(e) {
  e.preventDefault();
  if (!state.key) {
    showToast('יש להתחבר עם Google לפני הגשת עבודה', true);
    return;
  }
  const errEl = document.getElementById('create-error');
  errEl.hidden = true;
  const title = document.getElementById('f-title').value.trim();
  const description = document.getElementById('f-desc').value.trim();
  if (!title || !description) {
    errEl.textContent = 'כותרת ותיאור הם שדות חובה';
    errEl.hidden = false;
    return;
  }
  const btn = document.getElementById('btn-submit-create');
  btn.disabled = true;
  try {
    await api('createItem', {
      key: state.key, title: title, description: description,
      links: collectLinks(), images: pendingImages
    });
    showToast('העבודה הוגשה לוועד!');
    closeModal('modal-create');
    resetCreateForm();
    await loadAllData();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/* ===========================================================
   מודלים
   =========================================================== */
function openModal(id) {
  document.getElementById(id).hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  document.getElementById(id).hidden = true;
  document.body.style.overflow = '';
  if (id === 'modal-item') currentOpenItemId = null;
}

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay.id); });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      if (!overlay.hidden) closeModal(overlay.id);
    });
  }
});

document.getElementById('btn-open-create').addEventListener('click', () => {
  if (!state.key) { showToast('צריך להתחבר עם Google קודם', true); return; }
  resetCreateForm();
  openModal('modal-create');
});
document.getElementById('btn-add-link').addEventListener('click', () => addLinkRow(''));
document.getElementById('create-form').addEventListener('submit', submitCreateForm);

/* ===========================================================
   עזר: escaping
   =========================================================== */
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
function escapeAttr(str) { return escapeHtml(str); }

/* ===========================================================
   אתחול
   =========================================================== */
addLinkRow('');
setupImageWatcher('imgbb-target', pendingImages, 'image-previews');
setupImageWatcher('imgbb-target-review', pendingReviewImages, 'review-image-previews');
initGoogleAuth();
loadAllData();
