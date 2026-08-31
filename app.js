const CONFIG = {
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

let reconcileTimer = null;
function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => { loadAllData(); }, 10000);
}

/* ===========================================================
   עזר: קריאות לשרת
   =========================================================== */
async function api(action, payload) {
  if (!CONFIG.APPS_SCRIPT_URL) {
    showToast('השרת לא נמצא, אנא פנה למנהל המערכת', true);
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
    showToast('ההתחברות נכשלה', true);
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
  clearTimeout(reconcileTimer);
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
    loadingEl.textContent = 'שגיאה בטעינת הנתונים';
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

        const cardLinksHtml = (item.links && item.links.length)
      ? '<div class="item-card-links">' + item.links.map(l =>
          '<a href="' + escapeAttr(l) + '" target="_blank" rel="noopener noreferrer" class="item-card-link">' + escapeHtml(l) + '</a>'
        ).join('') + '</div>'
      : '';

    card.innerHTML =
      thumb +
      '<h3 class="item-card-title">' + escapeHtml(item.title) + '</h3>' +
      '<p class="item-card-desc">' + escapeHtml(item.description || '') + '</p>' +
      cardLinksHtml +
      '<div class="item-card-footer">' +
        '<span class="item-card-owner">מאת ' + escapeHtml(item.ownerName || 'אלמוני') + '</span>' +
        ratingRingHtml(item.avgRating, item.reviewCount, 42) +
      '</div>';

    card.querySelectorAll('.item-card-link').forEach(a => {
      a.addEventListener('click', (e) => e.stopPropagation());
    });

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
    ? '<div class="detail-images">' + item.images.map(u => '<img class="clickable-img" src="' + escapeAttr(u) + '" alt="" referrerpolicy="no-referrer">').join('') + '</div>'
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

  const ownerActions = document.getElementById('owner-actions');
  ownerActions.hidden = !item.isOwner;
  if (item.isOwner) {
    document.getElementById('btn-delete-item').onclick = () => deleteItem(item.itemId);
  }

  const reviewBox = document.getElementById('review-form-box');
  const signinNote = document.getElementById('signin-note');
  const ownerNote = document.getElementById('owner-note');
  reviewBox.hidden = true; signinNote.hidden = true; ownerNote.hidden = true;

  if (!state.key) {
    signinNote.hidden = false;
  } else if (item.isOwner) {
    ownerNote.hidden = false;
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
    renderImagePreviews('review-image-previews', pendingReviewImages, false);
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
    btn.addEventListener('click', () => reactToReview(btn.dataset.reviewId, btn.dataset.type));
  });
  document.querySelectorAll('[data-delete-review-id]').forEach(btn => {
    btn.addEventListener('click', () => deleteReview(btn.dataset.deleteReviewId));
  });
}

function thumbSvg(direction, filled) {
  const rotate = direction === 'down' ? ' style="transform:rotate(180deg)"' : '';
  return (
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="' + (filled ? 'currentColor' : 'none') + '" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' + rotate + '>' +
      '<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>' +
    '</svg>'
  );
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
      ? '<div class="review-images">' + r.images.map(u => '<img class="clickable-img" src="' + escapeAttr(u) + '" alt="" referrerpolicy="no-referrer">').join('') + '</div>'
      : '';

    const likeBtn =
      '<button type="button" class="like-btn' + (r.myReaction === 'like' ? ' liked' : '') + '" data-review-id="' + escapeAttr(r.reviewId) + '" data-type="like"' +
      (r.canReact ? '' : ' disabled title="לא ניתן להגיב לביקורת שלך, או שצריך להתחבר"') + '>' +
        thumbSvg('up', r.myReaction === 'like') + (r.likeCount ? '<span>' + r.likeCount + '</span>' : '') +
      '</button>';
    const dislikeBtn =
      '<button type="button" class="like-btn dislike-btn' + (r.myReaction === 'dislike' ? ' liked' : '') + '" data-review-id="' + escapeAttr(r.reviewId) + '" data-type="dislike"' +
      (r.canReact ? '' : ' disabled title="לא ניתן להגיב לביקורת שלך, או שצריך להתחבר"') + '>' +
        thumbSvg('down', r.myReaction === 'dislike') + (r.dislikeCount ? '<span>' + r.dislikeCount + '</span>' : '') +
      '</button>';
    const deleteBtn = r.isMine
      ? '<button type="button" class="delete-review-btn" data-delete-review-id="' + escapeAttr(r.reviewId) + '">מחק ביקורת</button>'
      : '';

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
        '<div class="review-actions"><span class="reaction-group">' + likeBtn + dislikeBtn + '</span>' + deleteBtn + '</div>' +
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
  const images = pendingReviewImages.slice();
  const item = allItems[itemId];
  if (!item) return;

  // --- עדכון אופטימי: מציגים מיד, לפני שהשרת בכלל ענה ---
  const snapshot = JSON.parse(JSON.stringify(item));
  const existingId = item.myReview && item.myReview.reviewId;
  const optimisticReview = {
    reviewId: existingId || ('temp-' + Date.now()),
    reviewerName: state.name || 'אני',
    reviewerPicture: state.picture || '',
    stars: currentStars,
    comment: comment,
    images: images,
    createdAt: new Date().toISOString(),
    likeCount: 0,
    dislikeCount: 0,
    myReaction: null,
    canReact: false,
    isMine: true
  };
  const idx = existingId ? item.reviews.findIndex(r => r.reviewId === existingId) : -1;
  if (idx !== -1) item.reviews[idx] = optimisticReview;
  else item.reviews.unshift(optimisticReview);
  item.myReview = { reviewId: optimisticReview.reviewId, stars: currentStars, comment: comment, images: images };
  const sum = item.reviews.reduce((s, r) => s + r.stars, 0);
  item.avgRating = sum / item.reviews.length;
  item.reviewCount = item.reviews.length;

  renderFeed();
  renderItemDetail(item);
  showToast('הביקורת נשלחה');

  try {
    await api('addReview', { key: state.key, itemId: itemId, stars: currentStars, comment: comment, images: images });
  } catch (err) {
    allItems[itemId] = snapshot;
    renderFeed();
    if (currentOpenItemId === itemId) renderItemDetail(allItems[itemId]);
    showToast(err.message, true);
  }
  scheduleReconcile();
}

async function reactToReview(reviewId, type) {
  if (!state.key) { showToast('צריך להתחבר עם Google כדי להגיב', true); return; }
  const item = currentOpenItemId && allItems[currentOpenItemId];
  if (!item) return;
  const review = item.reviews.find(r => r.reviewId === reviewId);
  if (!review || !review.canReact) return;

  const snapshot = { myReaction: review.myReaction, likeCount: review.likeCount, dislikeCount: review.dislikeCount };
  const prev = review.myReaction;
  if (prev === type) {
    review.myReaction = null;
    if (type === 'like') review.likeCount--; else review.dislikeCount--;
  } else {
    if (prev === 'like') review.likeCount--;
    if (prev === 'dislike') review.dislikeCount--;
    review.myReaction = type;
    if (type === 'like') review.likeCount++; else review.dislikeCount++;
  }
  renderItemDetail(item);

  try {
    await api('reactToReview', { key: state.key, reviewId: reviewId, type: type });
  } catch (err) {
    review.myReaction = snapshot.myReaction;
    review.likeCount = snapshot.likeCount;
    review.dislikeCount = snapshot.dislikeCount;
    if (currentOpenItemId === item.itemId) renderItemDetail(item);
    showToast(err.message, true);
  }
  scheduleReconcile();
}

async function deleteReview(reviewId) {
  if (!confirm('למחוק את הביקורת?')) return;
  const item = currentOpenItemId && allItems[currentOpenItemId];
  if (!item) return;

  const snapshot = JSON.parse(JSON.stringify(item));
  item.reviews = item.reviews.filter(r => r.reviewId !== reviewId);
  item.myReview = null;
  const sum = item.reviews.reduce((s, r) => s + r.stars, 0);
  item.avgRating = item.reviews.length ? sum / item.reviews.length : 0;
  item.reviewCount = item.reviews.length;
  renderFeed();
  renderItemDetail(item);
  showToast('הביקורת נמחקה');

  try {
    await api('deleteReview', { key: state.key, reviewId: reviewId });
  } catch (err) {
    allItems[item.itemId] = snapshot;
    renderFeed();
    if (currentOpenItemId === item.itemId) renderItemDetail(allItems[item.itemId]);
    showToast(err.message, true);
  }
  scheduleReconcile();
}

async function deleteItem(itemId) {
  if (!confirm('למחוק את העבודה? הפעולה בלתי הפיכה, וכל הביקורות עליה יימחקו גם כן.')) return;

  const snapshotItem = allItems[itemId];
  const snapshotIdx = itemOrder.indexOf(itemId);
  delete allItems[itemId];
  itemOrder = itemOrder.filter(id => id !== itemId);
  closeModal('modal-item');
  renderFeed();
  showToast('העבודה נמחקה');

  try {
    await api('deleteItem', { key: state.key, itemId: itemId });
    scheduleReconcile();
  } catch (err) {
    // מחיקה נכשלה - משחזרים מיד את המצב האמיתי מהשרת, לא מחכים 10 שניות
    if (snapshotItem) {
      allItems[itemId] = snapshotItem;
      itemOrder.splice(snapshotIdx, 0, itemId);
      renderFeed();
    }
    showToast(err.message, true);
    loadAllData();
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
function renderImagePreviews(containerId, imagesArray, allowPrimary) {
  const box = document.getElementById(containerId);
  box.innerHTML = imagesArray.map((url, idx) => {
    const isPrimary = allowPrimary && idx === 0;
    const primaryUi = !allowPrimary ? '' : (
      isPrimary
        ? '<span class="primary-badge">ראשית</span>'
        : '<button type="button" class="set-primary" data-idx="' + idx + '">הפוך לראשית</button>'
    );
    return (
      '<div class="image-preview' + (isPrimary ? ' is-primary' : '') + '">' +
        '<img src="' + escapeAttr(url) + '" alt="" referrerpolicy="no-referrer">' +
        '<button type="button" class="remove-img" data-remove-idx="' + idx + '" aria-label="הסר תמונה">✕</button>' +
        primaryUi +
      '</div>'
    );
  }).join('');
  box.querySelectorAll('.remove-img').forEach(btn => {
    btn.addEventListener('click', () => {
      imagesArray.splice(Number(btn.dataset.removeIdx), 1);
      renderImagePreviews(containerId, imagesArray, allowPrimary);
    });
  });
  if (allowPrimary) {
    box.querySelectorAll('.set-primary').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const chosen = imagesArray.splice(idx, 1)[0];
        imagesArray.unshift(chosen);
        renderImagePreviews(containerId, imagesArray, allowPrimary);
      });
    });
  }
}

// ה-widget של imgbb כותב HTML (data-auto-insert="html-embed-full") לתוך הטקסטאריה המוסתרת
// המתאימה, לכל תמונה שהועלתה. שולפים משם את כתובות ה-URL ומרוקנים את הטקסטאריה
// כדי שהעלאה הבאה תתחיל נקי.
function setupImageWatcher(textareaId, imagesArray, previewsContainerId, allowPrimary) {
  const ta = document.getElementById(textareaId);
  if (!ta) return;
  ta.addEventListener('input', () => {
    const matches = ta.value.matchAll(/<img[^>]*\ssrc=["']([^"']+)["']/gi);
    let added = false;
    for (const m of matches) {
      if (m[1] && !imagesArray.includes(m[1])) { imagesArray.push(m[1]); added = true; }
    }
    ta.value = '';
    renderImagePreviews(previewsContainerId, imagesArray, allowPrimary);
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
  renderImagePreviews('image-previews', pendingImages, true);
  document.getElementById('create-error').hidden = true;
}

async function submitCreateForm(e) {
  e.preventDefault();
  if (!state.key) {
    showToast('יש להתחבר עם גוגל לפני הגשת עבודה', true);
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
  const links = collectLinks();
  const images = pendingImages.slice();

  // --- עדכון אופטימי: מוסיפים לפיד מיד עם מזהה זמני, לפני תשובת השרת ---
  const tempId = 'temp-' + Date.now();
  allItems[tempId] = {
    itemId: tempId, ownerName: state.name || 'אני', title: title, description: description,
    links: links, images: images, createdAt: new Date().toISOString(),
    isOwner: true, myReview: null, avgRating: 0, reviewCount: 0, reviews: []
  };
  itemOrder.unshift(tempId);
  renderFeed();
  closeModal('modal-create');
  resetCreateForm();
  showToast('העבודה הוגשה לוועד!');

  try {
    await api('createItem', { key: state.key, title: title, description: description, links: links, images: images });
  } catch (err) {
    delete allItems[tempId];
    itemOrder = itemOrder.filter(id => id !== tempId);
    renderFeed();
    showToast(err.message, true);
  }
  scheduleReconcile();
}

/* ===========================================================
   תצוגה מקדימה גדולה לתמונות (Lightbox)
   =========================================================== */
document.addEventListener('click', (e) => {
  const img = e.target.closest('.clickable-img');
  if (!img) return;
  document.getElementById('lightbox-img').src = img.src;
  openModal('modal-lightbox');
});

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
  if (!state.key) { showToast('צריך להתחבר עם גוגל קודם', true); return; }
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
setupImageWatcher('imgbb-target', pendingImages, 'image-previews', true);
setupImageWatcher('imgbb-target-review', pendingReviewImages, 'review-image-previews', false);
initGoogleAuth();
loadAllData();
