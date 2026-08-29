/* ===========================================================
   הגדרות
   =========================================================== */
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

let pendingImages = []; // תמונות שהועלו ל-imgbb עבור הפריט שנוצר כרגע
let currentStars = 0;

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
    loadFeed();
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
}

function renderAuthArea() {
  const area = document.getElementById('auth-area');
  if (state.key) {
    area.innerHTML = '';
    const chip = document.createElement('div');
    chip.className = 'user-chip';
    chip.innerHTML =
      (state.picture ? '<img src="' + escapeAttr(state.picture) + '" alt="">' : '') +
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
   פיד
   =========================================================== */
async function loadFeed() {
  try {
    const data = await api('listItems', {});
    renderFeed(data.items || []);
  } catch (err) {
    showToast('שגיאה בטעינת הפיד: ' + err.message, true);
  }
}

function renderFeed(items) {
  const grid = document.getElementById('feed-grid');
  const empty = document.getElementById('feed-empty');
  const count = document.getElementById('feed-count');
  count.textContent = items.length ? (items.length + ' עבודות') : '';
  grid.innerHTML = '';
  empty.hidden = items.length > 0;

  items.forEach(item => {
    const card = document.createElement('article');
    card.className = 'item-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const thumb = (item.images && item.images[0])
      ? '<img class="item-card-thumb" src="' + escapeAttr(item.images[0]) + '" alt="">'
      : '';

    const stampHtml = item.reviewCount > 0
      ? '<span class="stamp">★ ' + item.avgRating.toFixed(1) + ' · ' + item.reviewCount + '</span>'
      : '<span class="stamp stamp-empty">אין עדיין ביקורות</span>';

    card.innerHTML =
      thumb +
      '<h3 class="item-card-title">' + escapeHtml(item.title) + '</h3>' +
      '<p class="item-card-desc">' + escapeHtml(item.description || '') + '</p>' +
      '<div class="item-card-footer">' +
        '<span class="item-card-owner">מאת ' + escapeHtml(item.ownerName || 'אלמוני') + '</span>' +
        stampHtml +
      '</div>';

    card.addEventListener('click', () => openItemDetail(item.itemId));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openItemDetail(item.itemId); });
    grid.appendChild(card);
  });
}

/* ===========================================================
   פרטי פריט + ביקורות
   =========================================================== */
async function openItemDetail(itemId) {
  try {
    const item = await api('getItem', { itemId: itemId, key: state.key || '' });
    renderItemDetail(item);
    openModal('modal-item');
  } catch (err) {
    showToast('שגיאה בטעינת הפריט: ' + err.message, true);
  }
}

function renderItemDetail(item) {
  const el = document.getElementById('item-detail-content');

  const imagesHtml = (item.images && item.images.length)
    ? '<div class="detail-images">' + item.images.map(u => '<img src="' + escapeAttr(u) + '" alt="">').join('') + '</div>'
    : '';

  const linksHtml = (item.links && item.links.length)
    ? '<ul class="detail-links">' + item.links.map(l => '<li><a href="' + escapeAttr(l) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(l) + '</a></li>').join('') + '</ul>'
    : '';

  const ratingHtml = item.reviewCount > 0
    ? '<span class="stamp">★ ' + item.avgRating.toFixed(1) + '</span><span style="color:var(--ink-faint);font-size:13px">' + item.reviewCount + ' ביקורות</span>'
    : '<span class="stamp stamp-empty">אין עדיין ביקורות - היו הראשונים</span>';

  let actionHtml = '';
  if (!state.key) {
    actionHtml = '<p class="signin-note">צריך להתחבר עם גוגל כדי לכתוב ביקורת.</p>';
  } else if (item.isOwner) {
    actionHtml = '<p class="owner-note">זו העבודה שלך - אי אפשר לבקר על עבודה שהעלית בעצמך, אבל אפשר לראות מה אחרים כתבו למטה.</p>';
  } else {
    const my = item.myReview || null;
    currentStars = my ? my.stars : 0;
    actionHtml =
      '<div class="review-form-box">' +
        '<p class="review-form-title">' + (my ? 'עדכון הביקורת שלך' : 'כתיבת ביקורת') + '</p>' +
        '<div class="star-picker" id="star-picker"></div>' +
        '<textarea class="field-input field-textarea" id="review-comment" placeholder="מה עבד, מה פחות, ומה כדאי לשנות? (אופציונלי)">' + escapeHtml(my ? my.comment : '') + '</textarea>' +
        '<p class="form-error" id="review-error" hidden></p>' +
        '<button class="btn btn-primary btn-block" id="btn-submit-review" style="margin-top:12px">' + (my ? 'עדכן ביקורת' : 'שלח ביקורת') + '</button>' +
      '</div>';
  }

  el.innerHTML =
    '<p class="detail-owner">הוגש על ידי ' + escapeHtml(item.ownerName || 'אלמוני') + '</p>' +
    '<h2 class="detail-title">' + escapeHtml(item.title) + '</h2>' +
    imagesHtml +
    '<p class="detail-desc">' + escapeHtml(item.description || '') + '</p>' +
    linksHtml +
    '<div class="detail-rating-summary">' + ratingHtml + '</div>' +
    actionHtml +
    '<hr class="divider">' +
    '<p class="reviews-title">ביקורות (' + (item.reviews ? item.reviews.length : 0) + ')</p>' +
    renderReviewsList(item.reviews || []);

  if (state.key && !item.isOwner) {
    renderStarPicker(currentStars);
    document.getElementById('btn-submit-review').addEventListener('click', () => submitReview(item.itemId));
  }
}

function renderReviewsList(reviews) {
  if (!reviews.length) return '<p class="reviews-empty">עדיין אין ביקורות על העבודה הזו.</p>';
  return reviews.map(r => {
    const stars = '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars);
    const time = r.createdAt ? new Date(r.createdAt).toLocaleDateString('he-IL') : '';
    return (
      '<div class="review-item">' +
        '<div class="review-item-head">' +
          '<span class="review-author">' + escapeHtml(r.reviewerName || 'אלמוני') + '</span>' +
          '<span class="review-time">' + time + '</span>' +
        '</div>' +
        '<div class="review-stars">' + stars + '</div>' +
        (r.comment ? '<p class="review-comment">' + escapeHtml(r.comment) + '</p>' : '') +
      '</div>'
    );
  }).join('');
}

function renderStarPicker(selected) {
  const box = document.getElementById('star-picker');
  box.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = i <= selected ? '★' : '☆';
    b.dataset.value = i;
    if (i <= selected) b.classList.add('active');
    b.addEventListener('click', () => {
      currentStars = i;
      renderStarPicker(currentStars);
    });
    box.appendChild(b);
  }
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
    await api('addReview', { key: state.key, itemId: itemId, stars: currentStars, comment: comment });
    showToast('הביקורת נשלחה, תודה!');
    openItemDetail(itemId);
    loadFeed();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    btn.disabled = false;
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

function renderImagePreviews() {
  const box = document.getElementById('image-previews');
  box.innerHTML = pendingImages.map((url, idx) =>
    '<div class="image-preview">' +
      '<img src="' + escapeAttr(url) + '" alt="">' +
      '<button type="button" data-idx="' + idx + '" aria-label="הסר תמונה">✕</button>' +
    '</div>'
  ).join('');
  box.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingImages.splice(Number(btn.dataset.idx), 1);
      renderImagePreviews();
    });
  });
}

// ה-widget של imgbb כותב HTML (data-autoinsert="html-embed-full") לתוך הטקסטאריה הזו
// לכל תמונה שהועלתה. שולפים משם את כתובות ה-URL ומרוקנים את הטקסטאריה כדי שהעלאה הבאה תתחיל נקי.
function watchImgbbTarget() {
  const ta = document.getElementById('imgbb-target');
  if (!ta) return;
  ta.addEventListener('input', () => {
    const matches = ta.value.matchAll(/<img[^>]*\ssrc=["']([^"']+)["']/gi);
    for (const m of matches) {
      if (m[1] && !pendingImages.includes(m[1])) pendingImages.push(m[1]);
    }
    ta.value = '';
    renderImagePreviews();
  });
}

function resetCreateForm() {
  document.getElementById('create-form').reset();
  document.getElementById('links-list').innerHTML = '';
  addLinkRow('');
  pendingImages = [];
  renderImagePreviews();
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
      key: state.key,
      title: title,
      description: description,
      links: collectLinks(),
      images: pendingImages
    });
    showToast('העבודה הוגשה לוועד!');
    closeModal('modal-create');
    resetCreateForm();
    loadFeed();
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
watchImgbbTarget();
initGoogleAuth();
loadFeed();
