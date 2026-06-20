/**
 * IndexedDB cache layer for quota data.
 * Supports LRU eviction and automatic cleanup.
 */

const DB_NAME = 'quota-cache';
const DB_VERSION = 1;
const STORE_QUOTAS = 'quotas';
const STORE_METADATA = 'metadata';
const MAX_ENTRIES = 500;

interface QuotaCacheEntry {
  id: string;                // Composite key: "provider:fileName"
  provider: string;          // "claude" | "antigravity" | "codex" | "kimi" | "xai"
  fileName: string;          // "file1.json"
  data: any;                 // Quota data (native object, no serialization needed)
  cachedAt: number;          // Data fetch timestamp
  accessedAt: number;        // Last access timestamp (for LRU)
  version: number;           // Data structure version (for migration)
}

interface CacheMetadata {
  id: string;                // Fixed: "metadata"
  version: number;           // Database version
  totalEntries: number;      // Total entry count
  lastCleanup: number;       // Last cleanup timestamp
  maxEntries: number;        // Max entries (default 500)
}

class IndexedDBQuotaCache {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly dataVersion = 1;

  constructor() {
    this.initPromise = this.init();
  }

  /**
   * Initialize database
   */
  private async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('Failed to open IndexedDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create quotas store
        if (!db.objectStoreNames.contains(STORE_QUOTAS)) {
          const quotaStore = db.createObjectStore(STORE_QUOTAS, { keyPath: 'id' });
          quotaStore.createIndex('provider', 'provider', { unique: false });
          quotaStore.createIndex('cachedAt', 'cachedAt', { unique: false });
          quotaStore.createIndex('accessedAt', 'accessedAt', { unique: false });
          quotaStore.createIndex('fileName', 'fileName', { unique: false });
        }

        // Create metadata store
        if (!db.objectStoreNames.contains(STORE_METADATA)) {
          db.createObjectStore(STORE_METADATA, { keyPath: 'id' });
        }

        // Initialize metadata
        const transaction = (event.target as IDBOpenDBRequest).transaction!;
        const metadataStore = transaction.objectStore(STORE_METADATA);
        const metadata: CacheMetadata = {
          id: 'metadata',
          version: DB_VERSION,
          totalEntries: 0,
          lastCleanup: Date.now(),
          maxEntries: MAX_ENTRIES,
        };
        metadataStore.put(metadata);
      };
    });
  }

  /**
   * Ensure database is initialized
   */
  private async ensureDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    await this.initPromise;
    if (!this.db) throw new Error('Failed to initialize IndexedDB');
    return this.db;
  }

  /**
   * Generate cache key
   */
  private makeKey(provider: string, fileName: string): string {
    return `${provider}:${fileName}`;
  }

  /**
   * Get single quota data
   */
  async get<T>(provider: string, fileName: string): Promise<T | null> {
    try {
      const db = await this.ensureDB();
      const key = this.makeKey(provider, fileName);

      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_QUOTAS], 'readwrite');
        const store = transaction.objectStore(STORE_QUOTAS);
        const request = store.get(key);

        request.onsuccess = () => {
          const entry: QuotaCacheEntry | undefined = request.result;
          if (!entry) {
            resolve(null);
            return;
          }

          // Update access time (LRU)
          entry.accessedAt = Date.now();
          store.put(entry);

          resolve(entry.data as T);
        };

        request.onerror = () => {
          console.error('Failed to get quota from IndexedDB:', request.error);
          reject(request.error);
        };
      });
    } catch (err) {
      console.error('IndexedDB get error:', err);
      return null;
    }
  }

  /**
   * Batch get quota data (for preloading)
   */
  async batchGet(provider: string, fileNames: string[]): Promise<Map<string, any>> {
    try {
      const db = await this.ensureDB();
      const result = new Map<string, any>();

      return new Promise((resolve) => {
        const transaction = db.transaction([STORE_QUOTAS], 'readwrite');
        const store = transaction.objectStore(STORE_QUOTAS);
        let completed = 0;

        fileNames.forEach((fileName) => {
          const key = this.makeKey(provider, fileName);
          const request = store.get(key);

          request.onsuccess = () => {
            const entry: QuotaCacheEntry | undefined = request.result;
            if (entry) {
              // Update access time
              entry.accessedAt = Date.now();
              store.put(entry);
              result.set(fileName, entry.data);
            }

            completed++;
            if (completed === fileNames.length) {
              resolve(result);
            }
          };

          request.onerror = () => {
            console.error(`Failed to get ${key}:`, request.error);
            completed++;
            if (completed === fileNames.length) {
              resolve(result);
            }
          };
        });
      });
    } catch (err) {
      console.error('IndexedDB batchGet error:', err);
      return new Map();
    }
  }

  /**
   * Save quota data
   */
  async set(provider: string, fileName: string, data: any, cachedAt: number = Date.now()): Promise<void> {
    try {
      const db = await this.ensureDB();
      const key = this.makeKey(provider, fileName);

      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE_QUOTAS, STORE_METADATA], 'readwrite');
        const quotaStore = transaction.objectStore(STORE_QUOTAS);
        const metadataStore = transaction.objectStore(STORE_METADATA);

        // Check if it's a new entry
        const getRequest = quotaStore.get(key);
        getRequest.onsuccess = () => {
          const isNew = !getRequest.result;

          const entry: QuotaCacheEntry = {
            id: key,
            provider,
            fileName,
            data,
            cachedAt,
            accessedAt: Date.now(),
            version: this.dataVersion,
          };

          quotaStore.put(entry);

          // Update metadata
          if (isNew) {
            const metaRequest = metadataStore.get('metadata');
            metaRequest.onsuccess = () => {
              const metadata: CacheMetadata = metaRequest.result || {
                id: 'metadata',
                version: DB_VERSION,
                totalEntries: 0,
                lastCleanup: Date.now(),
                maxEntries: MAX_ENTRIES,
              };
              metadata.totalEntries++;
              metadataStore.put(metadata);
            };
          }
        };

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });

      // Check if cleanup is needed
      await this.cleanupIfNeeded();
    } catch (err) {
      console.error('IndexedDB set error:', err);
    }
  }

  /**
   * Get cached timestamp
   */
  async getCachedAt(provider: string, fileName: string): Promise<number | null> {
    try {
      const db = await this.ensureDB();
      const key = this.makeKey(provider, fileName);

      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_QUOTAS], 'readonly');
        const store = transaction.objectStore(STORE_QUOTAS);
        const request = store.get(key);

        request.onsuccess = () => {
          const entry: QuotaCacheEntry | undefined = request.result;
          resolve(entry?.cachedAt ?? null);
        };

        request.onerror = () => {
          console.error('Failed to get cachedAt:', request.error);
          reject(request.error);
        };
      });
    } catch (err) {
      console.error('IndexedDB getCachedAt error:', err);
      return null;
    }
  }

  /**
   * Delete single entry
   */
  async delete(provider: string, fileName: string): Promise<void> {
    try {
      const db = await this.ensureDB();
      const key = this.makeKey(provider, fileName);

      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE_QUOTAS, STORE_METADATA], 'readwrite');
        const quotaStore = transaction.objectStore(STORE_QUOTAS);
        const metadataStore = transaction.objectStore(STORE_METADATA);

        quotaStore.delete(key);

        // Update metadata
        const metaRequest = metadataStore.get('metadata');
        metaRequest.onsuccess = () => {
          const metadata: CacheMetadata = metaRequest.result;
          if (metadata) {
            metadata.totalEntries = Math.max(0, metadata.totalEntries - 1);
            metadataStore.put(metadata);
          }
        };

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (err) {
      console.error('IndexedDB delete error:', err);
    }
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    try {
      const db = await this.ensureDB();

      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE_QUOTAS, STORE_METADATA], 'readwrite');
        const quotaStore = transaction.objectStore(STORE_QUOTAS);
        const metadataStore = transaction.objectStore(STORE_METADATA);

        quotaStore.clear();

        const metadata: CacheMetadata = {
          id: 'metadata',
          version: DB_VERSION,
          totalEntries: 0,
          lastCleanup: Date.now(),
          maxEntries: MAX_ENTRIES,
        };
        metadataStore.put(metadata);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (err) {
      console.error('IndexedDB clear error:', err);
    }
  }

  /**
   * Query all file names by provider
   */
  async getFileNamesByProvider(provider: string): Promise<string[]> {
    try {
      const db = await this.ensureDB();

      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_QUOTAS], 'readonly');
        const store = transaction.objectStore(STORE_QUOTAS);
        const index = store.index('provider');
        const request = index.getAll(provider);

        request.onsuccess = () => {
          const entries: QuotaCacheEntry[] = request.result;
          resolve(entries.map((e) => e.fileName));
        };

        request.onerror = () => {
          console.error('Failed to get fileNames:', request.error);
          reject(request.error);
        };
      });
    } catch (err) {
      console.error('IndexedDB getFileNamesByProvider error:', err);
      return [];
    }
  }

  /**
   * LRU cleanup: when entries exceed maxEntries, delete oldest 20%
   */
  private async cleanupIfNeeded(): Promise<void> {
    try {
      const db = await this.ensureDB();

      const metadata = await new Promise<CacheMetadata | null>((resolve) => {
        const transaction = db.transaction([STORE_METADATA], 'readonly');
        const store = transaction.objectStore(STORE_METADATA);
        const request = store.get('metadata');
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      });

      if (!metadata || metadata.totalEntries <= metadata.maxEntries) {
        return;
      }

      // Get all entries, sorted by accessedAt
      const allEntries = await new Promise<QuotaCacheEntry[]>((resolve) => {
        const transaction = db.transaction([STORE_QUOTAS], 'readonly');
        const store = transaction.objectStore(STORE_QUOTAS);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve([]);
      });

      // Sort by access time, delete oldest 20%
      allEntries.sort((a, b) => a.accessedAt - b.accessedAt);
      const deleteCount = Math.ceil(allEntries.length * 0.2);
      const toDelete = allEntries.slice(0, deleteCount);

      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE_QUOTAS, STORE_METADATA], 'readwrite');
        const quotaStore = transaction.objectStore(STORE_QUOTAS);
        const metadataStore = transaction.objectStore(STORE_METADATA);

        toDelete.forEach((entry) => {
          quotaStore.delete(entry.id);
        });

        // Update metadata
        const metaRequest = metadataStore.get('metadata');
        metaRequest.onsuccess = () => {
          const meta: CacheMetadata = metaRequest.result;
          if (meta) {
            meta.totalEntries -= deleteCount;
            meta.lastCleanup = Date.now();
            metadataStore.put(meta);
          }
        };

        transaction.oncomplete = () => {
          console.log(`IndexedDB cleanup: deleted ${deleteCount} old entries`);
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (err) {
      console.error('IndexedDB cleanup error:', err);
    }
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{ totalEntries: number; byProvider: Record<string, number> }> {
    try {
      const db = await this.ensureDB();

      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_QUOTAS], 'readonly');
        const store = transaction.objectStore(STORE_QUOTAS);
        const request = store.getAll();

        request.onsuccess = () => {
          const entries: QuotaCacheEntry[] = request.result;
          const byProvider: Record<string, number> = {};

          entries.forEach((entry) => {
            byProvider[entry.provider] = (byProvider[entry.provider] || 0) + 1;
          });

          resolve({
            totalEntries: entries.length,
            byProvider,
          });
        };

        request.onerror = () => reject(request.error);
      });
    } catch (err) {
      console.error('IndexedDB getStats error:', err);
      return { totalEntries: 0, byProvider: {} };
    }
  }
}

export const indexedDBQuotaCache = new IndexedDBQuotaCache();
