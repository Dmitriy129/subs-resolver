const download = document.getElementById('download');
const upload = document.getElementById('upload');
const fileInput = document.getElementById('file');
const status = document.getElementById('status');
const base = new URL('./api/short-links/', window.location.href);

function busy(value) {
  download.disabled = value;
  upload.disabled = value;
  fileInput.disabled = value;
}
async function request(path, options) {
  const response = await fetch(new URL(path, base), { cache: 'no-store', ...options });
  if (!response.ok) {
    const messages = { 400: 'Некорректный JSON: проверьте формат, имена и HTTP(S)-адреса.', 413: 'Файл больше 8 МиБ.', 507: 'Данные после обработки превышают 8 МиБ.' };
    throw new Error(messages[response.status] ?? `Ошибка сервера (${response.status}).`);
  }
  return response;
}
download.onclick = async () => {
  busy(true);
  status.textContent = 'Готовим выгрузку…';
  try {
    const blob = await (await request('export')).blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'short-links.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    status.textContent = 'JSON подготовлен для скачивания.';
  } catch (error) { status.textContent = error.message; }
  finally { busy(false); }
};
document.getElementById('import-form').onsubmit = async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  busy(true);
  status.textContent = 'Проверяем файл…';
  let submitted = false;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('Файл больше 8 МиБ.');
    const body = await file.text();
    let data;
    try { data = JSON.parse(body); } catch { throw new Error('Файл содержит некорректный JSON.'); }
    if (data?.version !== 1 || !data.links || typeof data.links !== 'object' || Array.isArray(data.links)) {
      throw new Error('Нужен JSON, выгруженный этим сервисом: version 1 и объект links.');
    }
    const count = Object.keys(data.links).length;
    if (!window.confirm(`Заменить ВСЕ сохранённые ссылки данными из файла (${count} записей)? Текущий список будет удалён. Рекомендуется сначала скачать его JSON.`)) {
      status.textContent = 'Загрузка отменена. Данные не изменены.';
      return;
    }
    submitted = true;
    const result = await (await request('import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })).json();
    status.textContent = `Готово. Сохранено ссылок: ${result.imported}. Они уже работают.`;
    fileInput.value = '';
  } catch (error) {
    status.textContent = error.message + (submitted ? ' Если связь прервалась, скачайте JSON для проверки результата перед повтором.' : ' Данные не изменены.');
  } finally { busy(false); }
};
