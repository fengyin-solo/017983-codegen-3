import { Logger } from '../utils/logger.js';

const logger = new Logger('BatchQueueStorage');

const DB_NAME = 'guqin_batch_queue';
const DB_VERSION = 1;
const STORE_NAME = 'items';

/**
 * 批量队列存储 - 基于 IndexedDB 持久化队列项
 * 队列项中包含音频文件 Blob、状态、进度与分析结果，
 * 关闭页面后重新打开仍可恢复队列进度与已完成结果。
 */
export class BatchQueueStorage {
  constructor() {
    this._dbPromise = null;
  }

  /**
   * 打开（或创建）数据库
   * @returns {Promise<IDBDatabase>}
   */
  open() {
    if (this._dbPromise) {
      return this._dbPromise;
    }

    this._dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('当前浏览器不支持 IndexedDB，无法恢复批量队列'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };

      request.onsuccess = () => {
        logger.info('IndexedDB 已就绪');
        resolve(request.result);
      };

      request.onerror = () => {
        logger.error('IndexedDB 打开失败', request.error);
        reject(request.error);
      };
    });

    return this._dbPromise;
  }

  /**
   * 执行一次对象 store 请求
   * @param {string} mode - 事务模式 readonly | readwrite
   * @param {(store: IDBObjectStore) => IDBRequest} action
   * @returns {Promise<any>}
   */
  async _request(mode, action) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 读取单条队列项中保存的音频文件 Blob
   * @param {string} id
   * @returns {Promise<File|Blob|null>}
   */
  async getFile(id) {
    const item = await this.get(id);
    return item && item.file ? item.file : null;
  }

  /**
   * 读取单条队列项
   * @param {string} id
   * @returns {Promise<Object|undefined>}
   */
  get(id) {
    return this._request('readonly', store => store.get(id));
  }

  /**
   * 读取全部队列项
   * @returns {Promise<Array>}
   */
  getAll() {
    return this._request('readonly', store => store.getAll());
  }

  /**
   * 写入（新增或更新）一条队列项。
   * 若更新数据中不包含 file（如状态/进度更新），保留已存储的音频 Blob。
   * @param {Object} item
   */
  async put(item) {
    let record = item;
    if (!item.file) {
      try {
        const existing = await this.get(item.id);
        if (existing && existing.file) {
          record = { ...item, file: existing.file };
        }
      } catch (error) {
        logger.warn('合并队列项 Blob 失败', error);
      }
    }
    return this._request('readwrite', store => store.put(record));
  }

  /**
   * 删除一条队列项
   * @param {string} id
   */
  delete(id) {
    return this._request('readwrite', store => store.delete(id));
  }

  /**
   * 清空整个队列
   */
  clear() {
    return this._request('readwrite', store => store.clear());
  }
}
