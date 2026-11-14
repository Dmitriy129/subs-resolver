import { buildSubscriptionUrl, checkLength, LINK_LIMIT } from './index.js';

export function parseSubscriptionLink(value) {
  const url = new URL(value);
  const sources = url.searchParams.getAll('subs');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !sources.length
      || [...url.searchParams.keys()].some(key => !['subs', 'no_cache'].includes(key))) {
    throw new Error('Это не ссылка с подписками. Используйте обычную форму «Короткие ссылки».');
  }
  buildSubscriptionUrl(url.href, sources);
  const endpoint = new URL(url);
  endpoint.search = '';
  return { endpoint: endpoint.href, sources, noCache: url.searchParams.get('no_cache') === '1' };
}

if (typeof document !== 'undefined' && document.querySelector('#editor')) {
  const $ = id => document.getElementById(id);
  const base = new URL('./', location.href);
  let endpoint = base.href;
  let noCache = false;
  let checked = '';
  let exists = false;
  let busy = false;
  function lock(value) {
    busy = value;
    document.querySelectorAll('button, #name, #rows input').forEach(el => { el.disabled = value; });
    if (!value) renumber();
  }
  function changed() { $('result').hidden = true; $('saved').hidden = true; }
  function renumber() {
    const rows = [...$('rows').children];
    rows.forEach((row, i) => {
      row.querySelector('label').textContent = `${i + 1}. ${i ? 'Резервная подписка' : 'Основная подписка'}`;
      row.querySelector('[data-up]').disabled = i === 0;
      row.querySelector('[data-down]').disabled = i === rows.length - 1;
      row.querySelector('[data-remove]').disabled = rows.length === 1;
    });
  }
  let serial = 0;
  function add(value = '', top = false, focus = false) {
    const row = document.createElement('div');
    row.className = 'source-row';
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'url'; input.spellcheck = false; input.value = value;
    input.id = `source-${++serial}`; label.htmlFor = input.id;
    input.placeholder = 'https://example.com/sub/id';
    input.oninput = changed;
    row.append(label, input);
    for (const [action, text] of [['up', '↑ Выше'], ['down', '↓ Ниже'], ['remove', 'Удалить']]) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset[action] = ''; button.textContent = text;
      button.onclick = () => {
        if (action === 'up' && row.previousElementSibling) row.previousElementSibling.before(row);
        if (action === 'down' && row.nextElementSibling) row.nextElementSibling.after(row);
        if (action === 'remove' && $('rows').children.length > 1) row.remove();
        changed(); renumber();
      };
      row.append(button);
    }
    if (top) $('rows').prepend(row); else $('rows').append(row);
    changed(); renumber(); if (focus) input.focus();
  }
  async function api(method, body) {
    const response = await fetch(new URL(`api/short-links/item/${checked}`, base), {
      method, cache: 'no-store', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(response.status === 409 ? 'Имя уже занято. Нажмите «Проверить» ещё раз.' : `Ошибка ${response.status}. Проверьте имя заново или повторите запрос.`);
    return response.json();
  }
  $('name').oninput = () => { checked = ''; $('editor').hidden = true; changed(); $('status').textContent = ''; };
  $('check').onclick = async () => {
    if (busy) return;
    checked = $('name').value;
    $('editor').hidden = true; changed();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(checked)) { $('status').textContent = 'Имя: латинские буквы, цифры, дефис или подчёркивание (1–64).'; return; }
    lock(true); $('status').textContent = 'Проверяем…';
    try {
      const data = await api('GET');
      exists = data.exists;
      const parsed = exists ? parseSubscriptionLink(data.url) : { endpoint: base.href, sources: ['', ''], noCache: false };
      endpoint = parsed.endpoint; noCache = parsed.noCache;
      $('rows').replaceChildren(); parsed.sources.forEach(value => add(value));
      $('mode').textContent = exists ? 'Редактирование существующей ссылки' : 'Создание новой ссылки';
      $('editor').hidden = false; $('status').textContent = '';
    } catch (error) { $('status').textContent = error.message; }
    finally { lock(false); }
  };
  $('add-top').onclick = () => add('', true, true);
  $('add-bottom').onclick = () => add('', false, true);
  $('editor').onsubmit = async event => {
    event.preventDefault(); if (busy || !checked) return;
    lock(true); $('status').textContent = ''; $('saved').hidden = true;
    try {
      const url = new URL(buildSubscriptionUrl(endpoint, [...$('rows').querySelectorAll('input')].map(input => input.value)));
      if (noCache) url.searchParams.set('no_cache', '1');
      $('long-url').value = url.href;
      $('count').textContent = `${url.href.length} / ${LINK_LIMIT} символов`;
      $('result').hidden = false;
      checkLength(url.href);
      const data = await api(exists ? 'PUT' : 'POST', { url: url.href });
      exists = true; $('mode').textContent = 'Редактирование существующей ссылки';
      $('short-url').value = new URL(data.path, location.origin).href;
      $('saved').hidden = false; $('status').textContent = 'Сохранено';
    } catch (error) { $('status').textContent = error.message; }
    finally { lock(false); }
  };
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('short-url').value); $('status').textContent = 'Скопировано'; }
    catch { $('short-url').select(); $('status').textContent = 'Скопируйте выделенную ссылку вручную.'; }
  };
}
