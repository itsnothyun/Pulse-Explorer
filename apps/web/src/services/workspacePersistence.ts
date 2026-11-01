/**
 * Local-first workspace persistence in IndexedDB. Metadata (files, folders,
 * annotations, open tabs, UI prefs) lives in one snapshot record; original
 * file bytes live in their own store keyed by file id so they are written
 * once and never re-serialised.
 */
const DB_NAME = 'omniview-workspace';
const DB_VERSION = 1;
const META = 'meta';
const BUFFERS = 'buffers';
const SNAPSHOT_KEY = 'snapshot';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(BUFFERS)) db.createObjectStore(BUFFERS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadSnapshot<T>(): Promise<T | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(META, 'readonly');
    return ((await request(tx.objectStore(META).get(SNAPSHOT_KEY))) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function loadBuffers(ids: string[]): Promise<Record<string, ArrayBuffer>> {
  const out: Record<string, ArrayBuffer> = {};
  try {
    const db = await openDb();
    const store = db.transaction(BUFFERS, 'readonly').objectStore(BUFFERS);
    await Promise.all(
      ids.map(async (id) => {
        const buf = (await request(store.get(id))) as ArrayBuffer | undefined;
        if (buf) out[id] = buf;
      })
    );
  } catch {
    // Missing buffers surface as unreadable files rather than a failed start.
  }
  return out;
}

const writtenBufferIds = new Set<string>();

/** Remember buffers that were just loaded so they are not written back. */
export function markBuffersPersisted(ids: string[]) {
  ids.forEach((id) => writtenBufferIds.add(id));
}

export async function saveWorkspace<T>(snapshot: T, buffers: Record<string, ArrayBuffer>): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([META, BUFFERS], 'readwrite');
    tx.objectStore(META).put(snapshot, SNAPSHOT_KEY);
    const bufferStore = tx.objectStore(BUFFERS);
    const liveIds = new Set(Object.keys(buffers));
    for (const id of liveIds) {
      if (!writtenBufferIds.has(id)) {
        bufferStore.put(buffers[id], id);
        writtenBufferIds.add(id);
      }
    }
    for (const id of Array.from(writtenBufferIds)) {
      if (!liveIds.has(id)) {
        bufferStore.delete(id);
        writtenBufferIds.delete(id);
      }
    }
    await done(tx);
  } catch (err) {
    console.warn('[Pulse] Workspace persistence failed', err);
  }
}

export async function clearWorkspace(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction([META, BUFFERS], 'readwrite');
    tx.objectStore(META).clear();
    tx.objectStore(BUFFERS).clear();
    writtenBufferIds.clear();
    await done(tx);
  } catch {
    // Nothing to clear.
  }
}
