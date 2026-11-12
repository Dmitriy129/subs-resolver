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
