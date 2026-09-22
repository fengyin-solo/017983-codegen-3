import { Logger } from '../utils/logger.js';

const logger = new Logger('BatchQueue');

/** 队列项状态 */
export const BatchItemStatus = {
  PENDING: 'pending',   // 排队中
  RUNNING: 'running',   // 分析中
  SUCCESS: 'success',   // 已完成
  ERROR: 'error'        // 失败（可单独重试）
};

/**
 * 分析任务所需的执行器
 * @typedef {Object} BatchRunner
 * @property {(file: File) => Promise<AudioBuffer>} decodeFile - 解码音频文件
 * @property {(audioData: Float32Array, sampleRate: number, fftSize: number, onProgress?: (p: number) => void) => Promise<Object>} analyze - 执行分析
 */

/**
 * 批量分析队列 - 负责逐条串行分析、状态管理、进度统计与持久化恢复。
 * 单条失败不会中断后续任务，失败项可单独重试。
 */
export class BatchQueue {
  /**
   * @param {BatchQueueStorage} storage - 持久化存储
   * @param {BatchRunner} runner - 分析执行器
   */
  constructor(storage, runner) {
    this.storage = storage;
    this.runner = runner;
    /** @type {Array<Object>} */
    this.items = [];
    this.running = false;
    this._listeners = new Set();
    this._orderSeq = 0;
  }

  /**
   * 订阅队列变化事件
   * @param {(event: {type: string, item?: Object, payload?: any}) => void} listener
   * @returns {() => void} 取消订阅
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  emit(type, item = null, payload = null) {
    for (const listener of this._listeners) {
      try {
        listener({ type, item, payload });
      } catch (error) {
        logger.error('队列事件监听器执行异常', error);
      }
    }
  }

  /**
   * 从存储恢复队列。上次处于 running 的任务视为未完成，重置为 pending。
   */
  async restore() {
    try {
      const stored = await this.storage.getAll();
      if (!Array.isArray(stored)) return;

      stored.sort((a, b) => (a.order || 0) - (b.order || 0));

      this.items = stored.map(raw => {
        const item = raw;
        // Blob 不常驻内存，需要时通过 storage.getFile 读取
        delete item.file;
        if (item.analysisResult) {
          item.analysisResult = BatchQueue.reviveTypedArrays(item.analysisResult);
        }
        if (item.status === BatchItemStatus.RUNNING) {
          item.status = BatchItemStatus.PENDING;
          item.stage = '';
          item.progress = 0;
        }
        return item;
      });

      this._orderSeq = this.items.reduce((max, item) => Math.max(max, item.order || 0), 0);

      if (this.items.length > 0) {
        logger.info('恢复批量队列', { count: this.items.length });
        // 持久化被重置的状态
        for (const item of this.items) {
          await this.storage.put(this._serialize(item));
        }
      }
    } catch (error) {
      logger.error('恢复批量队列失败', error);
    } finally {
      this.emit('restore');
    }
  }

  /**
   * 加入多个音频文件
   * @param {File[]|FileList} files
   * @param {number} fftSize - 当前选择的 FFT 精度
   * @returns {Object} 加入结果 { added, skipped }
   */
  async addFiles(files, fftSize) {
    const list = Array.from(files || []);
    let added = 0;

    for (const file of list) {
      if (!file.type || !file.type.startsWith('audio/')) {
        continue;
      }

      this._orderSeq += 1;
      const now = Date.now();
      const item = {
        id: now.toString(36) + Math.random().toString(36).substr(2, 9),
        order: this._orderSeq,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        fftSize,
        status: BatchItemStatus.PENDING,
        progress: 0,
        stage: '',
        error: '',
        audioBuffer: null,
        analysisResult: null,
        durationMs: 0,
        sampleRate: 0,
        startMs: 0,
        endMs: 0,
        createdAt: now,
        completedAt: null
      };

      this.items.push(item);
      await this.storage.put(this._serialize(item, file));
      added += 1;
      this.emit('item-added', item);
    }

    logger.info('文件加入批量队列', { added });
    return { added, skipped: list.length - added };
  }

  /**
   * 启动队列（逐条串行分析）。已在运行时重复调用不会重复触发。
   */
  async start() {
    if (this.running) return;

    const hasPending = this.items.some(item => item.status === BatchItemStatus.PENDING);
    if (!hasPending) {
      this.emit('nothing-pending');
      return;
    }

    this.running = true;
    this.emit('run-start');

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      // 每次取最靠前的 pending 项，失败的任务会被跳过，不影响后续
      let item = this._getNextPending();
      while (item) {
        const result = await this._runItem(item);
        processed += 1;
        if (result.status === BatchItemStatus.SUCCESS) {
          succeeded += 1;
        } else {
          failed += 1;
        }
        item = this._getNextPending();
      }
    } finally {
      this.running = false;
      this.emit('run-end', null, { processed, succeeded, failed });
      logger.info('批量分析结束', { processed, succeeded, failed });
    }
  }

  _getNextPending() {
    return this.items
      .filter(item => item.status === BatchItemStatus.PENDING)
      .sort((a, b) => (a.order || 0) - (b.order || 0))[0] || null;
  }

  /**
   * 执行单条分析任务
   * @param {Object} item
   * @returns {Promise<Object>} 更新后的 item
   */
  async _runItem(item) {
    item.status = BatchItemStatus.RUNNING;
    item.progress = 5;
    item.stage = '正在加载音频文件...';
    item.error = '';
    await this._persist(item);
    this.emit('item-updated', item);

    try {
      // 1. 读取并解码音频（从 IndexedDB 取回文件 Blob，支持关闭页面后恢复）
      const file = await this.storage.getFile(item.id);

      let audioBuffer = item.audioBuffer;
      if (!audioBuffer) {
        if (!file) {
          throw new Error('音频文件已丢失，无法重新分析');
        }
        item.stage = '正在解码音频...';
        item.progress = 15;
        this.emit('item-updated', item);
        audioBuffer = await this.runner.decodeFile(file);
        item.audioBuffer = audioBuffer;
        item.durationMs = Math.floor(audioBuffer.duration * 1000);
        item.sampleRate = audioBuffer.sampleRate;
        item.endMs = item.durationMs;
      }

      // 2. 提取分析区间（整段音频）
      item.stage = '正在提取音频数据...';
      item.progress = 30;
      this.emit('item-updated', item);

      const channelData = audioBuffer.getChannelData(0);
      const selectedData = channelData.slice(0, channelData.length);

      // 让界面有机会渲染加载提示，再进入耗时计算
      await this._nextFrame();

      // 3. 执行频谱分析（分析器分阶段回报进度 0-100，映射到总进度 35%-95%）
      item.stage = '正在进行频谱分析...';
      item.progress = 35;
      this.emit('item-updated', item);

      const analysisResult = await this.runner.analyze(
        selectedData,
        audioBuffer.sampleRate,
        item.fftSize,
        (p, stage) => {
          item.progress = 35 + Math.round(Math.max(0, Math.min(100, p)) * 0.6);
          if (stage) item.stage = stage;
          this.emit('item-progress', item);
        }
      );

      // 4. 完成
      item.status = BatchItemStatus.SUCCESS;
      item.progress = 100;
      item.stage = '分析完成';
      item.error = '';
      item.analysisResult = analysisResult;
      item.completedAt = Date.now();

      await this._persist(item);
      this.emit('item-completed', item, { audioBuffer, audioData: selectedData });
      return item;
    } catch (error) {
      // 单条失败：标记后继续后面的任务，不中断队列
      logger.error('批量任务分析失败', { id: item.id, fileName: item.fileName, error });
      item.status = BatchItemStatus.ERROR;
      item.progress = 0;
      item.stage = '';
      item.error = (error && error.message) ? error.message : '分析失败，请重试';
      item.completedAt = null;
      await this._persist(item);
      this.emit('item-error', item);
      return item;
    }
  }

  /**
   * 单独重试失败的任务。队列空闲时立即执行；队列运行中则在后续轮次自动执行。
   * @param {string} id
   */
  async retryItem(id) {
    const item = this.getItem(id);
    if (!item || item.status !== BatchItemStatus.ERROR) return;

    item.status = BatchItemStatus.PENDING;
    item.progress = 0;
    item.stage = '';
    item.error = '';
    item.analysisResult = null;
    item.audioBuffer = null;
    item.completedAt = null;
    await this._persist(item);
    this.emit('item-updated', item);

    if (!this.running) {
      await this.start();
    }
  }

  /**
   * 移除一条任务
   * @param {string} id
   */
  async removeItem(id) {
    const index = this.items.findIndex(item => item.id === id);
    if (index === -1) return;
    if (this.items[index].status === BatchItemStatus.RUNNING) return;

    const [removed] = this.items.splice(index, 1);
    try {
      await this.storage.delete(id);
    } catch (error) {
      logger.error('删除队列项失败', error);
    }
    this.emit('item-removed', removed);
  }

  /**
   * 清空已完成的任务
   */
  async clearCompleted() {
    const toRemove = this.items.filter(item => item.status === BatchItemStatus.SUCCESS);
    this.items = this.items.filter(item => item.status !== BatchItemStatus.SUCCESS);
    for (const item of toRemove) {
      try {
        await this.storage.delete(item.id);
      } catch (error) {
        logger.error('删除已完成任务失败', error);
      }
    }
    this.emit('cleared');
  }

  /**
   * 清空整个队列（运行中不允许）
   */
  async clearAll() {
    if (this.running) return;
    this.items = [];
    try {
      await this.storage.clear();
    } catch (error) {
      logger.error('清空队列失败', error);
    }
    this.emit('cleared');
  }

  getItem(id) {
    return this.items.find(item => item.id === id) || null;
  }

  /**
   * 队列统计
   * @returns {{total:number, pending:number, running:number, success:number, error:number, progress:number}}
   */
  getStats() {
    const total = this.items.length;
    const count = status => this.items.filter(item => item.status === status).length;
    const pending = count(BatchItemStatus.PENDING);
    const running = count(BatchItemStatus.RUNNING);
    const success = count(BatchItemStatus.SUCCESS);
    const error = count(BatchItemStatus.ERROR);

    // 整体进度：已完成项为 100%，运行中的按其进度折算，待处理为 0%
    let weighted = success * 100 + error * 100;
    const runningItem = this.items.find(item => item.status === BatchItemStatus.RUNNING);
    if (runningItem) {
      weighted += runningItem.progress || 0;
    }
    const progress = total > 0 ? Math.round(weighted / total) : 0;

    return { total, pending, running, success, error, progress };
  }

  /**
   * 持久化队列项。file 为新增项的原始 File（含 Blob），其余情况复用已存 Blob。
   */
  async _persist(item, file = null) {
    try {
      await this.storage.put(this._serialize(item, file));
    } catch (error) {
      // 持久化失败不应中断分析流程
      logger.error('队列项持久化失败', error);
    }
  }

  /**
   * 生成可结构化存储的纯数据。AudioBuffer 与分析结果中的 TypedArray 转为普通数组。
   */
  _serialize(item, file = null) {
    const data = {
      id: item.id,
      order: item.order,
      fileName: item.fileName,
      fileSize: item.fileSize,
      fileType: item.fileType,
      fftSize: item.fftSize,
      status: item.status,
      progress: item.progress,
      stage: item.stage,
      error: item.error,
      durationMs: item.durationMs,
      sampleRate: item.sampleRate,
      startMs: item.startMs,
      endMs: item.endMs,
      createdAt: item.createdAt,
      completedAt: item.completedAt,
      analysisResult: item.analysisResult ? this._toJSON(item.analysisResult) : null
    };
    if (file) {
      data.file = file;
    }
    return data;
  }

  _toJSON(value) {
    if (value instanceof Float32Array || value instanceof Float64Array) {
      return { __typed: true, type: value.constructor.name, data: Array.from(value) };
    }
    if (Array.isArray(value)) {
      return value.map(v => this._toJSON(v));
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) {
        out[key] = this._toJSON(value[key]);
      }
      return out;
    }
    return value;
  }

  /**
   * 将持久化数据中的 TypedArray 标记还原（分析器期望 Float32Array）。
   */
  static reviveTypedArrays(value) {
    if (value && typeof value === 'object') {
      if (value.__typed && Array.isArray(value.data)) {
        const Ctor = value.type === 'Float64Array' ? Float64Array : Float32Array;
        return new Ctor(value.data);
      }
      if (Array.isArray(value)) {
        return value.map(v => BatchQueue.reviveTypedArrays(v));
      }
      for (const key of Object.keys(value)) {
        value[key] = BatchQueue.reviveTypedArrays(value[key]);
      }
    }
    return value;
  }

  _nextFrame() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
}
