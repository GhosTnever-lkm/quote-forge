'use strict';

const STORAGE_KEY = 'quoteforge.documents.v1';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let documents = loadDocuments();
let selectedId = documents[0]?.id;
let saveTimer;
let toastTimer;

function makeSample() {
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  return QuoteForgeCore.createDocument({
    type: 'quote', number: 'QUO-2601-8D4F', date: today, dueDate: due, currency: 'USD',
    from: { name: 'Northside Creative', email: 'hello@example.com', address: 'Baku, Azerbaijan' },
    to: { name: 'Willow & Co.', email: 'team@example.com', address: 'Remote' },
    lineItems: [
      { description: 'Brand identity direction', quantity: '1', unitPrice: '420.00' },
      { description: 'Landing page design', quantity: '2.5', unitPrice: '95.00' },
      { description: 'Design handoff & source files', quantity: '1', unitPrice: '80.00' },
    ],
    discount: { type: 'percent', value: '5' }, taxRate: '', notes: 'Предложение действует до указанной даты. Спасибо, что рассматриваете сотрудничество.',
  });
}

function restoreDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return null;
  const from = value.from && typeof value.from === 'object' ? value.from : {};
  const to = value.to && typeof value.to === 'object' ? value.to : {};
  const draft = QuoteForgeCore.createDocument({
    type: value.type === 'quote' ? 'quote' : 'invoice',
    number: typeof value.number === 'string' ? value.number.slice(0, 40) : undefined,
    date: typeof value.date === 'string' ? value.date.slice(0, 10) : undefined,
    dueDate: typeof value.dueDate === 'string' ? value.dueDate.slice(0, 10) : '',
    currency: typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) ? value.currency : 'USD',
    from: { name: typeof from.name === 'string' ? from.name.slice(0, 160) : '', email: typeof from.email === 'string' ? from.email.slice(0, 254) : '', address: typeof from.address === 'string' ? from.address.slice(0, 300) : '' },
    to: { name: typeof to.name === 'string' ? to.name.slice(0, 160) : '', email: typeof to.email === 'string' ? to.email.slice(0, 254) : '', address: typeof to.address === 'string' ? to.address.slice(0, 300) : '' },
    lineItems: Array.isArray(value.lineItems) ? value.lineItems.slice(0, 100).map((item) => ({ description: typeof item?.description === 'string' ? item.description.slice(0, 500) : '', quantity: typeof item?.quantity === 'string' || typeof item?.quantity === 'number' ? String(item.quantity) : '', unitPrice: typeof item?.unitPrice === 'string' || typeof item?.unitPrice === 'number' ? String(item.unitPrice) : '' })) : [],
    discount: value.discount && typeof value.discount === 'object' && ['fixed', 'percent'].includes(value.discount.type) ? { type: value.discount.type, value: String(value.discount.value ?? '') } : undefined,
    taxRate: typeof value.taxRate === 'string' || typeof value.taxRate === 'number' ? String(value.taxRate) : '',
    notes: typeof value.notes === 'string' ? value.notes.slice(0, 2000) : '',
  });
  if (typeof value.id === 'string' && value.id.length <= 100) draft.id = value.id;
  return draft;
}

function loadDocuments() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [makeSample()];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [makeSample()];
    return parsed.map(restoreDraft).filter(Boolean);
  } catch (error) {
    console.warn('QuoteForge could not restore saved drafts:', error);
    return [makeSample()];
  }
}

function current() { return documents.find((document) => document.id === selectedId) || documents[0]; }
function money(value, document = current()) {
  try { return QuoteForgeCore.formatCurrency(value, document.currency, 'ru-RU'); }
  catch { return `${value} ${document.currency}`; }
}
function totals(document = current()) {
  try { return QuoteForgeCore.calculateTotals(document.lineItems, document.discount, document.taxRate); }
  catch { return null; }
}
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(documents)); $('#save-status').textContent = '● Сохранено'; $('#save-status').classList.remove('unsaved'); }
    catch { $('#save-status').textContent = '● Не удалось сохранить'; $('#save-status').classList.add('unsaved'); toast('Не хватило места в хранилище браузера. Экспортируйте JSON-копию.'); }
  }, 180);
}
function changed() {
  $('#save-status').textContent = '● Сохранение…'; $('#save-status').classList.add('unsaved');
  renderList(); renderPreview(); persist();
}

function renderList() {
  const list = $('#doc-list');
  $('#doc-count').textContent = String(documents.length);
  if (!documents.length) { list.innerHTML = '<div class="empty-items">Пока нет документов</div>'; return; }
  list.innerHTML = documents.map((document) => {
    const result = totals(document);
    const party = document.to?.name?.trim() || 'Без названия клиента';
    const kind = document.type === 'quote' ? 'ПРЕДЛОЖЕНИЕ' : 'СЧЁТ';
    return `<button class="doc-card ${document.id === selectedId ? 'active' : ''}" data-select="${escapeHtml(document.id)}">
      <span class="doc-card-top"><span class="doc-type">${kind}</span><span class="doc-date">${escapeHtml(document.date || '')}</span></span>
      <span class="doc-party">${escapeHtml(party)}</span><span class="doc-number">${escapeHtml(document.number)} · ${result ? money(result.total, document) : 'Добавьте позиции'}</span>
    </button>`;
  }).join('');
}

function renderLines() {
  const document = current();
  const host = $('#line-items');
  if (!document.lineItems.length) { host.innerHTML = '<div class="empty-items">Добавьте первую позицию — сумма посчитается автоматически.</div>'; return; }
  host.innerHTML = document.lineItems.map((line, index) => {
    let amount = '—';
    try { amount = money(QuoteForgeCore.calculateTotals([line]).total, document); } catch { /* incomplete row */ }
    return `<div class="line-row">
      <input data-index="${index}" data-line-key="description" aria-label="Описание позиции ${index + 1}" placeholder="Услуга или товар" value="${escapeHtml(line.description)}">
      <input data-index="${index}" data-line-key="quantity" aria-label="Количество ${index + 1}" type="number" min="0.000001" step="0.001" placeholder="1" value="${escapeHtml(line.quantity)}">
      <input data-index="${index}" data-line-key="unitPrice" aria-label="Цена ${index + 1}" type="number" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(line.unitPrice)}">
      <span class="amount">${escapeHtml(amount)}</span><button class="remove-line" data-remove="${index}" title="Удалить позицию" aria-label="Удалить позицию ${index + 1}">×</button>
    </div>`;
  }).join('');
}

function renderForm() {
  const document = current();
  if (!document) return;
  $$('[data-field]').forEach((element) => { element.value = document[element.dataset.field] ?? ''; });
  $$('[data-party]').forEach((element) => { element.value = document[element.dataset.party]?.[element.dataset.key] ?? ''; });
  $('[data-discount-type]').value = document.discount.type;
  $('[data-discount-value]').value = document.discount.value;
  $('#doc-kind-label').textContent = `${document.type === 'quote' ? 'ПРЕДЛОЖЕНИЕ' : 'СЧЁТ'} · ЧЕРНОВИК`;
  $('#doc-heading').textContent = document.number || 'Новый документ';
  $('#type-select').value = document.type;
  renderLines(); renderPreview(); renderList();
}

function renderPreview() {
  const document = current();
  if (!document) return;
  const isQuote = document.type === 'quote';
  const result = totals(document);
  const party = (side) => {
    const person = document[side] || {};
    return `<div><div class="preview-party-label">${side === 'from' ? 'ОТ КОГО' : 'ДЛЯ КОГО'}</div>
      <div class="preview-party-name">${escapeHtml(person.name || (side === 'from' ? 'Ваше имя или компания' : 'Имя клиента'))}</div>
      <div class="preview-party-detail">${[person.email, person.address].filter(Boolean).map(escapeHtml).join('<br>')}</div></div>`;
  };
  const rows = document.lineItems.map((line) => {
    let amount = '—';
    try { amount = money(QuoteForgeCore.calculateTotals([line]).total, document); } catch { /* keep draft visible */ }
    return `<tr><td>${escapeHtml(line.description || 'Описание позиции')}</td><td>${escapeHtml(line.quantity || '—')}</td><td>${escapeHtml(money(line.unitPrice || 0, document))}</td><td>${escapeHtml(amount)}</td></tr>`;
  }).join('');
  const summary = result ? `<div class="preview-summary">
    <div class="summary-row"><span>Промежуточный итог</span><strong>${escapeHtml(money(result.subtotal, document))}</strong></div>
    ${result.discountCents !== '0' ? `<div class="summary-row"><span>Скидка</span><strong>− ${escapeHtml(money(result.discount, document))}</strong></div>` : ''}
    ${result.taxCents !== '0' ? `<div class="summary-row"><span>Налог · ${escapeHtml(document.taxRate)}%</span><strong>${escapeHtml(money(result.tax, document))}</strong></div>` : ''}
    <div class="summary-row total"><span>Итого</span><strong>${escapeHtml(money(result.total, document))}</strong></div>
  </div>` : '<div class="preview-summary"><div class="summary-row"><span>Итого</span><strong>Заполните позиции</strong></div></div>';
  $('#preview-sheet').innerHTML = `
    <div class="preview-brand"><div class="preview-logo"><i>Q</i> QuoteForge</div><div class="preview-doc-type">${isQuote ? 'ПРЕДЛОЖЕНИЕ' : 'СЧЁТ'}<small>${isQuote ? 'КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ' : 'СЧЁТ НА ОПЛАТУ'}</small></div></div>
    <div class="preview-number">№ ${escapeHtml(document.number)} <span>·</span> ${escapeHtml(document.date)}${document.dueDate ? ` <span>·</span> ${isQuote ? 'Действует до' : 'Срок'}: ${escapeHtml(document.dueDate)}` : ''}</div>
    <div class="preview-parties">${party('from')}${party('to')}</div>
    <table class="preview-table"><thead><tr><th>ОПИСАНИЕ</th><th>КОЛ-ВО</th><th>ЦЕНА</th><th>СУММА</th></tr></thead><tbody>${rows || '<tr><td colspan="4">Добавьте работы или услуги</td></tr>'}</tbody></table>
    ${summary}
    ${document.notes ? `<div class="preview-notes">${escapeHtml(document.notes)}</div>` : ''}
    <div class="preview-footer"><span>Подготовлено в QuoteForge</span><span>${escapeHtml(document.currency)}</span></div>`;
}

function newDocument(type) {
  const document = QuoteForgeCore.createDocument({ type });
  document.lineItems = [{ description: '', quantity: '1', unitPrice: '0.00' }];
  documents.unshift(document); selectedId = document.id; renderForm(); changed();
  $('#number-field').focus();
}

document.addEventListener('input', (event) => {
  const document = current();
  if (!document) return;
  const target = event.target;
  if (target.matches('[data-field]')) document[target.dataset.field] = target.value;
  else if (target.matches('[data-party]')) document[target.dataset.party][target.dataset.key] = target.value;
  else if (target.matches('[data-discount-value]')) document.discount.value = target.value;
  else if (target.matches('[data-index][data-line-key]')) document.lineItems[Number(target.dataset.index)][target.dataset.lineKey] = target.value;
  else return;
  if (target.matches('[data-index][data-line-key]')) renderLines();
  $('#doc-heading').textContent = document.number || 'Новый документ';
  $('#doc-kind-label').textContent = `${document.type === 'quote' ? 'ПРЕДЛОЖЕНИЕ' : 'СЧЁТ'} · ЧЕРНОВИК`;
  changed();
});

document.addEventListener('change', (event) => {
  const document = current();
  if (!document) return;
  if (event.target.matches('[data-discount-type]')) document.discount.type = event.target.value;
  else if (event.target.matches('[data-field="type"]')) {
    document.type = event.target.value;
    if (document.number.startsWith('INV-') || document.number.startsWith('QUO-')) document.number = QuoteForgeCore.generateDocumentNumber(document.type === 'quote' ? 'QUO' : 'INV', new Date(), documents.map((item) => item.number));
    $('#number-field').value = document.number;
  } else return;
  $('#doc-heading').textContent = document.number;
  $('#doc-kind-label').textContent = `${document.type === 'quote' ? 'ПРЕДЛОЖЕНИЕ' : 'СЧЁТ'} · ЧЕРНОВИК`;
  changed();
});

document.addEventListener('click', (event) => {
  const select = event.target.closest('[data-select]');
  if (select) { selectedId = select.dataset.select; renderForm(); return; }
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    const document = current();
    document.lineItems.splice(Number(remove.dataset.remove), 1);
    renderLines(); changed(); return;
  }
});

$('#new-invoice').addEventListener('click', () => newDocument('invoice'));
$('#new-quote').addEventListener('click', () => newDocument('quote'));
$('#add-item').addEventListener('click', () => { current().lineItems.push({ description: '', quantity: '1', unitPrice: '0.00' }); renderLines(); changed(); $('#line-items input[data-line-key="description"]:last-of-type')?.focus(); });
$('#print-doc').addEventListener('click', () => window.print());
$('#duplicate-doc').addEventListener('click', () => {
  const original = current();
  const copy = QuoteForgeCore.createDocument({ ...JSON.parse(JSON.stringify(original)), id: undefined, number: QuoteForgeCore.generateDocumentNumber(original.type === 'quote' ? 'QUO' : 'INV', new Date(), documents.map((item) => item.number)), date: new Date().toISOString().slice(0, 10) });
  documents.unshift(copy); selectedId = copy.id; renderForm(); changed(); toast('Создана копия документа');
});
$('#export-doc').addEventListener('click', () => {
  try {
    const blob = new Blob([QuoteForgeCore.exportJSON(current())], { type: 'application/json' });
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${current().number.replace(/[^A-Z0-9_-]/gi, '_')}.json` });
    link.click(); URL.revokeObjectURL(link.href); toast('JSON-файл подготовлен');
  } catch (error) { toast(`Сначала заполните документ: ${error.message}`); }
});
$('#import-doc').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const text = await file.text();
    const imported = QuoteForgeCore.importJSON(text);
    const ids = new Set(documents.map((item) => item.id));
    const numbers = documents.map((item) => item.number);
    if (ids.has(imported.id)) imported.id = QuoteForgeCore.createDocument().id;
    if (numbers.includes(imported.number)) imported.number = QuoteForgeCore.generateDocumentNumber(imported.type === 'quote' ? 'QUO' : 'INV', new Date(), numbers);
    documents.unshift(imported); selectedId = imported.id; renderForm(); changed(); toast('Документ импортирован локально');
  } catch (error) { toast(error.message); }
  event.target.value = '';
});

renderForm();
