/** Cola persistente en IndexedDB: un acta sobrevive a cortes de red, recargas y cierres (RT-6). */
const DB_NAME = 'jurado';
const STORE = 'outbox';

const open = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'idem' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const inStore = async (mode, operation) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = operation(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const outbox = {
  put: (item) => inStore('readwrite', (store) => store.put(item)),
  remove: (idem) => inStore('readwrite', (store) => store.delete(idem)),
  all: () => inStore('readonly', (store) => store.getAll()),
};
