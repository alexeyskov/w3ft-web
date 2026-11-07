const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_FILES = 4096;

function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\\') || path.includes(':') || /[\x00-\x1f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Некорректный путь сохранения');
  }
  return path;
}

function complete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Запись сохранений прервана'));
  });
}

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function digest(data) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
}

function base64(data) {
  let binary = '';
  const bytes = new Uint8Array(data);
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

export class SaveStore {
  async open() {
    if (this.database) return this.database;
    const request = indexedDB.open('wc3-web-saves', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', {keyPath: 'path'});
    this.database = await result(request);
    return this.database;
  }

  async list() {
    const db = await this.open();
    return result(db.transaction('files').objectStore('files').getAll());
  }

  async read(path) {
    const db = await this.open();
    const file = await result(db.transaction('files').objectStore('files').get(safePath(path)));
    return file ? new Uint8Array(file.data) : null;
  }

  async write(path, data) {
    safePath(path);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength > MAX_FILE) throw new Error('Сохранение превышает 32 МБ');
    await this.putFiles([{path, data: bytes.slice().buffer, modified: Date.now()}]);
  }

  async applyChanges({files=[],deleted=[]}) {
    const now=Date.now(),prepared=files.map(file=>{
      const bytes=file.data instanceof Uint8Array?file.data:new Uint8Array(file.data);
      return {path:safePath(file.path),data:bytes.slice().buffer,modified:now};
    });
    await this.putFiles(prepared,deleted.map(safePath));
  }

  async putFiles(files,deleted=[]) {
    const db = await this.open();
    const transaction = db.transaction('files', 'readwrite');
    const done = complete(transaction);
    const objectStore = transaction.objectStore('files');
    let validationError;
    const request = objectStore.getAll();
    // Read, validate replacements and write within one transaction. Concurrent
    // tabs cannot both pass a quota check against the same previous snapshot.
    request.onsuccess = () => {
      try {
        const merged = new Map(request.result.map(file => [file.path, file]));
        for (const path of deleted) merged.delete(path);
        for (const file of files) merged.set(file.path, file);
        if (merged.size > MAX_FILES) throw new Error('Допустимо не более 4096 сохранений');
        let total = 0;
        for (const file of merged.values()) {
          if (!(file.data instanceof ArrayBuffer) || file.data.byteLength > MAX_FILE) throw new Error('Некорректный размер сохранения');
          total += file.data.byteLength;
        }
        if (total > MAX_TOTAL) throw new Error('Общий размер сохранений превышает 128 МБ');
        for (const path of deleted) objectStore.delete(path);
        for (const file of files) objectStore.put(file);
      } catch (error) {
        validationError = error;
        transaction.abort();
      }
    };
    try { await done; }
    catch (error) { throw validationError || error; }
  }

  async remove(path) {
    const db = await this.open();
    const transaction = db.transaction('files', 'readwrite');
    const done = complete(transaction);
    transaction.objectStore('files').delete(safePath(path));
    await done;
  }

  async export() {
    const files = await this.list();
    return JSON.stringify({format: 'wc3-web-saves-v1', files: await Promise.all(files.map(async file => ({
      path: file.path, data: base64(file.data), sha256: await digest(file.data), modified: file.modified,
    })))}, null, 2);
  }

  async import(text) {
    if (text.length > MAX_TOTAL * 1.4) throw new Error('Архив сохранений слишком большой');
    const archive = JSON.parse(text);
    if (archive?.format !== 'wc3-web-saves-v1' || !Array.isArray(archive.files) || archive.files.length > MAX_FILES) throw new Error('Неподдерживаемый формат сохранений');
    const paths = new Set();
    const files = [];
    let total = 0;
    for (const file of archive.files) {
      const path = safePath(file.path);
      if (paths.has(path)) throw new Error('Повторяющийся путь сохранения');
      paths.add(path);
      if (typeof file.data !== 'string' || file.data.length > MAX_FILE * 1.4) throw new Error('Сохранение слишком большое');
      const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
      total += bytes.byteLength;
      if (bytes.byteLength > MAX_FILE || total > MAX_TOTAL) throw new Error('Превышен размер сохранений');
      if (await digest(bytes) !== file.sha256) throw new Error(`Повреждено сохранение: ${path}`);
      files.push({path, data: bytes.buffer, modified: Number.isFinite(file.modified) ? file.modified : Date.now()});
    }
    await this.putFiles(files);
    return files.length;
  }
}
