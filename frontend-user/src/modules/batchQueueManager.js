import { Logger } from '../utils/logger.js';

const logger = new Logger('BatchQueueManager');

/**
 * 队列任务状态
 */
export const BatchStatus = {
  PENDING: 'pending',     // 等待中
  ANALYZING: 'analyzing', // 分析中
  DONE: 'done',           // 已完成
  FAILED: 'failed'        // 失败
};

/**
 * 批量分析队列管理器
 * 负责队列状态维护与持久化（IndexedDB），页面中途关闭后再次打开可恢复队列进度与结果
 */
export class BatchQueueManager {
  constructor() {
    this.DB_NAME = 'guqin_batch_queue';
    this.DB_VERSION = 1;
    this.ITEMS_STORE = 'items';  // 任务元数据与分析结果
    this.FILES_STORE = 'files';  // 待分析/失败任务的音频文件数据（Blob）
    this.MAX_FILE_SIZE = 100 * 1024 * 1024; // 单个文件上限 100MB

    this.items = [];
    this.db = null;
    this.persistent = false; // IndexedDB 是否可用（不可用时降级为仅当前会话有效）
    this.listener = null;
    this.lastCreated = 0;
  }

  /**
   * 注册状态变化监听
   * 事件类型：{ type: 'structure' } 结构变化（需整体重绘）；{ type: 'progress', id, progress } 单条进度更新
   */
  onChange(callback) {
    this.listener = callback;
  }

  notify(event) {
    if (this.listener) {
      this.listener(event);
    }
  }

  /**
   * 初始化：打开数据库并恢复上次未完成的队列
   */
  async init() {
    try {
      this.db = await this.openDatabase();
      this.persistent = true;
      this.items = await this.getAllItems();
      this.lastCreated = this.items.reduce((max, item) => Math.max(max, item.createdAt || 0), 0);

      // 上次关闭页面时仍在分析的任务，恢复为等待状态，允许继续分析
      const interrupted = this.items.filter(item => item.status === BatchStatus.ANALYZING);
      for (const item of interrupted) {
        item.status = BatchStatus.PENDING;
        item.progress = 0;
        item.interrupted = true;
        item.updatedAt = Date.now();
        await this.putItem(item);
      }

      logger.info('批量队列恢复完成', { total: this.items.length, interrupted: interrupted.length });
    } catch (error) {
      logger.error('批量队列持久化初始化失败，本次会话的队列将不会被保存', error);
      this.db = null;
      this.persistent = false;
      this.items = [];
    }
  }

  /* ---------------- IndexedDB 基础封装 ---------------- */

  openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.ITEMS_STORE)) {
          db.createObjectStore(this.ITEMS_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(this.FILES_STORE)) {
          db.createObjectStore(this.FILES_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  getStore(name, mode = 'readonly') {
    return this.db.transaction(name, mode).objectStore(name);
  }

  requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllItems() {
    const items = await this.requestToPromise(this.getStore(this.ITEMS_STORE).getAll());
    return (items || []).sort((a, b) => a.createdAt - b.createdAt);
  }

  async putItem(item) {
    if (!this.persistent) return;
    try {
      await this.requestToPromise(this.getStore(this.ITEMS_STORE, 'readwrite').put(item));
    } catch (error) {
      logger.error('队列任务持久化失败', error);
    }
  }

  async deleteItemRecord(id) {
    if (!this.persistent) return;
    try {
      await this.requestToPromise(this.getStore(this.ITEMS_STORE, 'readwrite').delete(id));
    } catch (error) {
      logger.error('删除队列任务记录失败', error);
    }
  }

  async saveFile(id, blob) {
    await this.requestToPromise(this.getStore(this.FILES_STORE, 'readwrite').put({ id, blob }));
  }

  /**
   * 读取任务对应的音频文件数据
   */
  async getFileData(id) {
    const item = this.items.find(i => i.id === id);
    if (!item) return null;
    if (item._file) return item._file; // 非持久化降级模式下的内存文件
    if (!this.persistent) return null;
    try {
      const record = await this.requestToPromise(this.getStore(this.FILES_STORE).get(id));
      return record ? record.blob : null;
    } catch (error) {
      logger.error('读取队列文件失败', error);
      return null;
    }
  }

  async deleteFile(id) {
    if (!this.persistent) return;
    try {
      await this.requestToPromise(this.getStore(this.FILES_STORE, 'readwrite').delete(id));
    } catch (error) {
      logger.error('删除队列文件失败', error);
    }
  }

  /**
   * 任务完成后释放文件数据，结果已保存在任务中，无需再保留原始音频
   */
  async discardFile(id) {
    const item = this.items.find(i => i.id === id);
    if (item && item._file) {
      delete item._file;
    }
    await this.deleteFile(id);
  }

  /* ---------------- 队列操作 ---------------- */

  /**
   * 批量添加文件到队列
   * @param {FileList|File[]} files - 文件列表
   * @param {Object} params - 分析参数快照 { fftSize }
   * @returns {Object} { added, skipped, oversized, failed }
   */
  async addFiles(files, params) {
    const list = Array.from(files || []);
    let added = 0;
    let skipped = 0;
    let oversized = 0;
    let failed = 0;

    for (const file of list) {
      if (!file.type.startsWith('audio/')) {
        skipped++;
        continue;
      }
      if (file.size > this.MAX_FILE_SIZE) {
        oversized++;
        continue;
      }

      const item = {
        id: this.generateId(),
        fileName: file.name,
        fileSize: file.size,
        status: BatchStatus.PENDING,
        progress: 0,
        error: null,
        result: null,
        duration: null,
        params: { fftSize: params.fftSize },
        interrupted: false,
        createdAt: this.nextCreatedAt(),
        updatedAt: Date.now()
      };

      try {
        if (this.persistent) {
          await this.saveFile(item.id, file);
        } else {
          item._file = file; // 降级模式：仅在当前会话内有效
        }
        this.items.push(item);
        await this.putItem(item);
        added++;
      } catch (error) {
        logger.error('文件加入队列失败', { name: file.name, error });
        failed++;
      }
    }

    if (added > 0) {
      this.notify({ type: 'structure' });
    }
    logger.info('批量添加文件', { added, skipped, oversized, failed });
    return { added, skipped, oversized, failed };
  }

  /**
   * 更新任务状态
   * @param {string} id - 任务 ID
   * @param {Object} updates - 更新的字段
   * @param {Object} options - { persist: 是否写入存储, progressEvent: 是否仅作为进度事件通知 }
   */
  updateItem(id, updates, { persist = true, progressEvent = false } = {}) {
    const item = this.items.find(i => i.id === id);
    if (!item) return null;

    Object.assign(item, updates);
    item.updatedAt = Date.now();

    if (persist) {
      // 不阻塞调用方，putItem 内部已捕获异常
      this.putItem(item);
    }

    if (progressEvent) {
      this.notify({ type: 'progress', id, progress: item.progress });
    } else {
      this.notify({ type: 'structure' });
    }
    return item;
  }

  /**
   * 移除单个任务（分析中的任务不允许移除）
   */
  async removeItem(id) {
    const item = this.items.find(i => i.id === id);
    if (!item || item.status === BatchStatus.ANALYZING) {
      return false;
    }
    this.items = this.items.filter(i => i.id !== id);
    await this.deleteItemRecord(id);
    await this.deleteFile(id);
    this.notify({ type: 'structure' });
    logger.info('移除队列任务', { id, fileName: item.fileName });
    return true;
  }

  /**
   * 清除所有已完成的任务
   * @returns {number} 清除的任务数量
   */
  async clearCompleted() {
    const done = this.items.filter(i => i.status === BatchStatus.DONE);
    for (const item of done) {
      await this.deleteItemRecord(item.id);
      await this.deleteFile(item.id);
    }
    this.items = this.items.filter(i => i.status !== BatchStatus.DONE);
    if (done.length > 0) {
      this.notify({ type: 'structure' });
    }
    logger.info('清除已完成任务', { count: done.length });
    return done.length;
  }

  /**
   * 清空整个队列（调用方需保证队列未在运行）
   */
  async clearAll() {
    this.items = [];
    if (this.persistent) {
      try {
        await this.requestToPromise(this.getStore(this.ITEMS_STORE, 'readwrite').clear());
        await this.requestToPromise(this.getStore(this.FILES_STORE, 'readwrite').clear());
      } catch (error) {
        logger.error('清空队列存储失败', error);
      }
    }
    this.notify({ type: 'structure' });
    logger.info('清空批量队列');
  }

  /**
   * 获取下一个等待分析的任务
   */
  getNextPending() {
    return this.items.find(i => i.status === BatchStatus.PENDING) || null;
  }

  getItem(id) {
    return this.items.find(i => i.id === id) || null;
  }

  getItems() {
    return [...this.items];
  }

  /**
   * 队列汇总信息（用于整体进度条）
   */
  getSummary() {
    const total = this.items.length;
    const done = this.items.filter(i => i.status === BatchStatus.DONE).length;
    const failed = this.items.filter(i => i.status === BatchStatus.FAILED).length;
    const pending = this.items.filter(i => i.status === BatchStatus.PENDING).length;
    const analyzing = this.items.filter(i => i.status === BatchStatus.ANALYZING).length;
    const analyzingItem = this.items.find(i => i.status === BatchStatus.ANALYZING);
    const currentFraction = analyzingItem ? analyzingItem.progress / 100 : 0;
    const overall = total === 0 ? 0 : Math.round(((done + failed + currentFraction) / total) * 100);

    return { total, done, failed, pending, analyzing, overall };
  }

  /**
   * 生成单调递增的创建时间，保证同一批次任务的入队顺序
   */
  nextCreatedAt() {
    this.lastCreated = Math.max(this.lastCreated, Date.now()) + 1;
    return this.lastCreated;
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }
}
