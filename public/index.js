export const LINK_LIMIT = 4000;
export function linkLength(value) { return value.length; }
export function checkLength(value) {
  const length = linkLength(value);
  if (length > LINK_LIMIT) throw Object.assign(new Error(`Ссылка слишком длинная: ${length} / ${LINK_LIMIT}. Уберите часть адреса или резервных подписок.`), { length });
}
function countLink(element, value) {
  const length = linkLength(value);
  element.textContent = `${length} / ${LINK_LIMIT} символов`;
  element.style.color = length > LINK_LIMIT ? '#a52228' : '';
}

export function buildSubscriptionUrl(endpoint, sources) {
  const result = new URL(endpoint);
  result.search = '';
  result.hash = '';
  if (!result.pathname.endsWith('/')) result.pathname += '/';
  if (!sources[0]?.trim()) {
    throw Object.assign(new Error('Укажите URL основной подписки.'), { rowIndex: 0 });
  }
  sources.forEach((value, rowIndex) => {
    const source = value.trim();
    if (!source) return;
    let valid = false;
    try {
      const url = new URL(source);
      valid = /^https?:\/\//i.test(source) && !/\s/.test(source)
        && ['http:', 'https:'].includes(url.protocol)
        && !url.username && !url.password && !source.includes('#');
    } catch { /* Show the same message for every invalid source format. */ }
    if (!valid) {
      throw Object.assign(new Error(`Подписка ${rowIndex + 1}: нужен полный HTTP(S)-адрес без логина, пароля, пробелов и фрагмента #.`), { rowIndex });
    }
    result.searchParams.append('subs', source);
  });
  return result.href;
}

if (typeof document !== 'undefined') {
  const form = document.querySelector('#builder');
  const sources = document.querySelector('#sources');
  const template = document.querySelector('#source-template');
  const result = document.querySelector('#result');
  const output = document.querySelector('#result-url');
  const error = document.querySelector('#error');
  const status = document.querySelector('#copy-status');
  let nextId = 0;

  function invalidate() {
    result.hidden = true;
    output.value = '';
    error.hidden = true;
    error.textContent = '';
    status.textContent = '';
    sources.querySelectorAll('input').forEach((input) => input.removeAttribute('aria-invalid'));
  }

  function renumber() {
    const rows = [...sources.children];
    rows.forEach((row, index) => {
      row.querySelector('label').textContent = index === 0 ? '1. Основная подписка' : `${index + 1}. Резервная подписка`;
      row.querySelector('input').required = index === 0;
      const remove = row.querySelector('.remove');
      remove.disabled = rows.length === 1;
      remove.setAttribute('aria-label', `Удалить подписку ${index + 1}`);
    });
  }

  function addRow(focus = false) {
    const row = template.content.firstElementChild.cloneNode(true);
    const input = row.querySelector('input');
    input.id = `source-${++nextId}`;
    row.querySelector('label').htmlFor = input.id;
    row.querySelector('.remove').addEventListener('click', () => {
      if (sources.children.length === 1) return;
      const nextInput = row.nextElementSibling?.querySelector('input')
        ?? row.previousElementSibling?.querySelector('input');
      row.remove();
      renumber();
      invalidate();
      nextInput?.focus();
    });
    sources.append(row);
    renumber();
    invalidate();
    if (focus) input.focus();
  }

  sources.addEventListener('input', invalidate);
  document.querySelector('#add-source').addEventListener('click', () => addRow(true));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    invalidate();
    const inputs = [...sources.querySelectorAll('input')];
    try {
      const endpoint = window.location.origin + window.location.pathname;
      output.value = buildSubscriptionUrl(endpoint, inputs.map((input) => input.value));
      result.hidden = false;
      countLink(document.querySelector('#builder-count'), output.value);
      const tooLong = linkLength(output.value) > LINK_LIMIT;
      document.querySelector('#copy-link').disabled = tooLong;
      document.querySelector('#make-short').disabled = tooLong;
      checkLength(output.value);
      output.focus();
      output.select();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      const input = inputs[failure.rowIndex ?? 0];
      input?.setAttribute('aria-invalid', 'true');
      input?.focus();
    }
  });
  document.querySelector('#copy-link').addEventListener('click', async () => {
    const link = output.value;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      if (output.value === link) status.textContent = 'Ссылка скопирована';
    } catch {
      if (output.value !== link) return;
      output.focus();
      output.select();
      status.textContent = 'Ссылка выделена — скопируйте её вручную.';
    }
  });
  addRow();
  addRow();
}

export function generateShortName() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) => alphabet[byte & 63]).join('');
}

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const name = $('short-name');
  const target = $('short-target');
  const updateCount = () => countLink($('target-count'), target.value);
  target.addEventListener('input', () => { $('target-count').textContent = ''; });
  const form = $('short-form');
  const status = $('short-status');
  const base = new URL('./api/short-links/', window.location.href);
  let checkedName = '';
  let editing = false;
  let revision = 0;
  let busy = false;

  function showShort(short) {
    $('builder-panel').hidden = short;
    $('short-panel').hidden = !short;
    $('show-builder').setAttribute('aria-pressed', String(!short));
    $('show-short').setAttribute('aria-pressed', String(short));
  }
  function reset() {
    revision++;
    checkedName = '';
    form.hidden = true;
    $('short-result').hidden = true;
    status.textContent = '';
  }
  function lock(value) {
    busy = value;
    for (const id of ['short-name', 'generate-name', 'check-name', 'save-short', 'short-target', 'make-short']) $(id).disabled = value;
  }
  async function api(path, options) {
    const response = await fetch(new URL(path, base), { cache: 'no-store', ...options });
    if (!response.ok) {
      const messages = { 409: 'Имя уже занято. Нажмите «Проверить», чтобы открыть редактирование.', 404: 'Ссылка не найдена. Нажмите «Проверить» ещё раз.', 400: 'Проверьте имя и полный HTTP(S)-адрес (до 8192 байт, без пробелов и пароля).', 507: 'Хранилище заполнено.' };
      throw new Error(messages[response.status] ?? `Ошибка сервера (${response.status}). Попробуйте ещё раз.`);
    }
    return response;
  }
  $('show-builder').onclick = () => showShort(false);
  $('show-short').onclick = () => showShort(true);
  $('make-short').onclick = () => {
    if (busy) return;
    reset();
    name.value = '';
    target.value = $('result-url').value;
    updateCount();
    showShort(true);
    name.focus();
  };
  name.oninput = reset;
  $('generate-name').onclick = () => { reset(); name.value = generateShortName(); name.focus(); };
  $('check-name').onclick = async () => {
    reset();
    const slug = name.value;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) {
      status.textContent = 'Имя: 1–64 латинские буквы, цифры, дефис или подчёркивание.';
      return;
    }
    const current = revision;
    lock(true);
    status.textContent = 'Проверяем…';
    try {
      const data = await (await api(`item/${slug}`)).json();
      if (current !== revision) return;
      checkedName = slug;
      editing = data.exists;
      if (editing) target.value = data.url;
      updateCount();
      $('short-mode').textContent = editing ? 'Редактирование существующей ссылки' : 'Имя свободно — создание новой ссылки';
      form.hidden = false;
      status.textContent = '';
    } catch (error) { status.textContent = error.message; }
    finally { lock(false); }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy || !checkedName || name.value !== checkedName) return;
    lock(true);
    status.textContent = 'Сохраняем…';
    try {
      updateCount();
      checkLength(target.value);
      const data = await (await api(`item/${checkedName}`, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: target.value.trim() }),
      })).json();
      editing = true;
      $('short-mode').textContent = 'Редактирование существующей ссылки';
      $('short-url').value = new URL(data.path, window.location.origin).href;
      $('short-result').hidden = false;
      status.textContent = 'Сохранено';
    } catch (error) { status.textContent = error.message; }
    finally { lock(false); }
  };
  $('copy-short').onclick = async () => {
    try { await navigator.clipboard.writeText($('short-url').value); status.textContent = 'Ссылка скопирована'; }
    catch { $('short-url').focus(); $('short-url').select(); status.textContent = 'Скопируйте выделенную ссылку вручную.'; }
  };
}
