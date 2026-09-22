import { Logger } from '../utils/logger.js';
import { BatchItemStatus } from './batchQueue.js';

const logger = new Logger('BatchQueueUI');

/**
 * 批量队列 UI 回调
 * @typedef {Object} BatchQueueUICallbacks
 * @property {(files: FileList|File[]) => void} onAddFiles - 选择/拖入音频文件
 * @property {() => void} onStart - 开始（或继续）批量分析
 * @property {(id: string) => void} onRetry - 重试单条
 * @property {(id: string) => void} onRemove - 移除单条
 * @property {(id: string) => void} onView - 查看已完成结果
 * @property {() => void} onClearCompleted - 清空已完成
 * @property {() => void} onClearAll - 清空队列
 * @property {() => void} onDismissResume - 关闭恢复提示
 */

const STATUS_TEXT = {
  [BatchItemStatus.PENDING]: '排队中',
  [BatchItemStatus.RUNNING]: '分析中',
  [BatchItemStatus.SUCCESS]: '已完成',
  [BatchItemStatus.ERROR]: '失败'
};

/**
 * 批量分析队列界面 - 负责队列列表、逐条进度、整体进度与加载提示渲染。
 */
export class BatchQueueUI {
  /**
   * @param {BatchQueue} queue
   * @param {BatchQueueUICallbacks} callbacks
   */
  constructor(queue, callbacks) {
    this.queue = queue;
    this.callbacks = callbacks;
    this.resumeDismissed = false;

    this.els = {
      input: document.getElementById('batchAudioInput'),
      addArea: document.getElementById('batchAddArea'),
      addBtn: document.getElementById('batchAddBtn'),
      startBtn: document.getElementById('batchStartBtn'),
      clearCompletedBtn: document.getElementById('batchClearCompletedBtn'),
      clearAllBtn: document.getElementById('batchClearAllBtn'),
      resumeBanner: document.getElementById('batchResumeBanner'),
      resumeText: document.getElementById('batchResumeText'),
      resumeBtn: document.getElementById('batchResumeBtn'),
      resumeDismiss: document.getElementById('batchResumeDismiss'),
      loadingBanner: document.getElementById('batchLoadingBanner'),
      loadingText: document.getElementById('batchLoadingText'),
      overall: document.getElementById('batchOverall'),
      overallFill: document.getElementById('batchOverallFill'),
      overallText: document.getElementById('batchOverallText'),
      overallCount: document.getElementById('batchOverallCount'),
      list: document.getElementById('batchList'),
      empty: document.getElementById('batchEmpty')
    };

    this.bindEvents();
    this.queue.subscribe(event => this.handleQueueEvent(event));
    this.render();
  }

  bindEvents() {
    const { els } = this;

    els.addArea.addEventListener('click', () => els.input.click());
    els.addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      els.input.click();
    });

    els.input.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        this.callbacks.onAddFiles(e.target.files);
      }
      els.input.value = '';
    });

    // 支持直接拖入多个音频
    els.addArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.addArea.classList.add('dragover');
    });
    els.addArea.addEventListener('dragleave', () => {
      els.addArea.classList.remove('dragover');
    });
    els.addArea.addEventListener('drop', (e) => {
      e.preventDefault();
      els.addArea.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        this.callbacks.onAddFiles(e.dataTransfer.files);
      }
    });

    els.startBtn.addEventListener('click', () => this.callbacks.onStart());
    els.clearCompletedBtn.addEventListener('click', () => this.callbacks.onClearCompleted());
    els.clearAllBtn.addEventListener('click', () => this.callbacks.onClearAll());

    els.resumeBtn.addEventListener('click', () => this.callbacks.onStart());
    els.resumeDismiss.addEventListener('click', () => this.callbacks.onDismissResume());

    // 列表内按钮使用事件委托
    els.list.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      const { action, id } = button.dataset;
      if (!id) return;

      if (action === 'retry') this.callbacks.onRetry(id);
      if (action === 'remove') this.callbacks.onRemove(id);
      if (action === 'view') this.callbacks.onView(id);
    });
  }

  handleQueueEvent(event) {
    switch (event.type) {
      case 'item-progress':
        // 高频进度事件：仅更新对应条目、加载横幅与整体进度，不重建列表
        this.updateItemProgress(event.item);
        this.renderOverall();
        if (this.queue.running) {
          this.renderLoadingBanner(this.queue.getStats(), true);
        }
        break;
      case 'item-updated':
        this.render();
        break;
      case 'item-added':
      case 'item-completed':
      case 'item-error':
      case 'item-removed':
      case 'cleared':
      case 'run-start':
      case 'run-end':
      case 'restore':
        this.render();
        break;
      case 'nothing-pending':
        break;
      default:
        this.render();
    }
  }

  /**
   * 全量渲染队列面板
   */
  render() {
    const stats = this.queue.getStats();
    const running = this.queue.running;

    this.renderOverall();
    this.renderList();
    this.renderLoadingBanner(stats, running);
    this.renderResumeBanner(stats);
    this.renderControls(stats, running);
  }

  renderControls(stats, running) {
    const { els } = this;

    // 运行中禁用可能触发重复分析/改动队列的按钮
    els.startBtn.disabled = running || stats.pending === 0;
    els.clearAllBtn.disabled = running || stats.total === 0;
    els.clearCompletedBtn.disabled = running || stats.success === 0;
    els.addBtn.disabled = running;
    els.input.disabled = running;
    els.addArea.classList.toggle('is-disabled', running);
  }

  renderLoadingBanner(stats, running) {
    const { els } = this;
    if (!running) {
      els.loadingBanner.style.display = 'none';
      return;
    }

    const runningItem = this.queue.items.find(item => item.status === BatchItemStatus.RUNNING);
    const currentName = runningItem ? runningItem.fileName : '';
    const stage = runningItem && runningItem.stage ? runningItem.stage : '准备中...';

    els.loadingBanner.style.display = 'flex';
    els.loadingText.innerHTML = `
      <span class="batch-loading-spinner"></span>
      <span class="batch-loading-detail">
        <strong>批量分析进行中，请稍候…</strong>
        <span class="batch-loading-stage">${this.escapeHtml(stage)}：${this.escapeHtml(currentName)}</span>
      </span>`;
  }

  renderResumeBanner(stats) {
    const { els } = this;
    if (this.resumeDismissed || stats.total === 0) {
      els.resumeBanner.style.display = 'none';
      return;
    }

    const unfinished = stats.pending + stats.error;
    if (unfinished > 0) {
      els.resumeBanner.style.display = 'flex';
      if (stats.pending > 0) {
        els.resumeText.textContent =
          `检测到上次未完成的批量任务（待分析 ${stats.pending} 条${stats.error > 0 ? `，失败 ${stats.error} 条` : ''}），可继续分析。`;
        els.resumeBtn.style.display = 'inline-flex';
      } else {
        // 仅剩失败项：需逐条重试，不存在可整体继续的任务
        els.resumeText.textContent =
          `检测到上次有 ${stats.error} 条分析失败的任务，可在列表中单独重试。`;
        els.resumeBtn.style.display = 'none';
      }
    } else {
      els.resumeBanner.style.display = 'none';
    }
  }

  dismissResume() {
    this.resumeDismissed = true;
    this.render();
  }

  renderOverall() {
    const stats = this.queue.getStats();
    const { els } = this;

    if (stats.total === 0) {
      els.overall.style.display = 'none';
      return;
    }

    els.overall.style.display = 'block';
    els.overallFill.style.width = `${stats.progress}%`;
    els.overallText.textContent = `${stats.progress}%`;
    els.overallCount.textContent =
      `共 ${stats.total} 条 · 完成 ${stats.success} · 失败 ${stats.error} · 待处理 ${stats.pending + stats.running}`;
  }

  renderList() {
    const { items } = this.queue;
    const { els } = this;

    if (items.length === 0) {
      els.list.innerHTML = '';
      els.list.style.display = 'none';
      els.empty.style.display = 'flex';
      return;
    }

    els.list.style.display = 'block';
    els.empty.style.display = 'none';

    els.list.innerHTML = items.map(item => this.renderItem(item)).join('');
  }

  renderItem(item) {
    const running = this.queue.running;
    const statusClass = `batch-item-status-${item.status}`;

    let actionHtml = '';
    if (item.status === BatchItemStatus.ERROR) {
      // 失败项可单独重试
      actionHtml += `
        <button class="batch-item-btn batch-item-retry" data-action="retry" data-id="${item.id}"
          title="重新分析这一条">↻ 重试</button>`;
    }
    if (item.status === BatchItemStatus.SUCCESS) {
      actionHtml += `
        <button class="batch-item-btn batch-item-view" data-action="view" data-id="${item.id}"
          title="查看分析结果与图表">📊 查看结果</button>`;
    }
    if (item.status !== BatchItemStatus.RUNNING) {
      // 运行中的任务不允许移除，避免状态错乱；其余条目可移除
      actionHtml += `
        <button class="batch-item-btn batch-item-remove" data-action="remove" data-id="${item.id}"
          ${running ? 'disabled' : ''} title="从队列移除">✕</button>`;
    }

    const metaParts = [];
    if (item.durationMs) {
      metaParts.push(`时长 ${(item.durationMs / 1000).toFixed(2)}s`);
    }
    metaParts.push(`FFT ${item.fftSize}`);
    metaParts.push(this.formatFileSize(item.fileSize));

    let detailHtml = '';
    if (item.status === BatchItemStatus.RUNNING) {
      detailHtml = `
        <div class="batch-item-progress">
          <div class="batch-item-progress-fill" style="width: ${item.progress || 0}%"></div>
        </div>
        <span class="batch-item-stage">${this.escapeHtml(item.stage || '准备中...')}</span>`;
    } else if (item.status === BatchItemStatus.SUCCESS) {
      const freq = item.analysisResult && item.analysisResult.fundamentalFreq
        ? item.analysisResult.fundamentalFreq.toFixed(2)
        : '--';
      detailHtml = `
        <span class="batch-item-result">基频 <strong>${freq} Hz</strong></span>
        <span class="batch-item-stage">${this.formatTime(item.completedAt)}</span>`;
    } else if (item.status === BatchItemStatus.ERROR) {
      detailHtml = `
        <span class="batch-item-error-msg" title="${this.escapeHtml(item.error)}">
          ⚠ ${this.escapeHtml(item.error)}
        </span>`;
    } else {
      detailHtml = `<span class="batch-item-stage">等待分析…</span>`;
    }

    return `
      <div class="batch-item ${statusClass}" data-id="${item.id}">
        <div class="batch-item-main">
          <span class="batch-item-status-dot" aria-hidden="true"></span>
          <div class="batch-item-info">
            <div class="batch-item-name" title="${this.escapeHtml(item.fileName)}">
              ${this.escapeHtml(item.fileName)}
            </div>
            <div class="batch-item-meta">${metaParts.join(' · ')}</div>
            <div class="batch-item-detail">${detailHtml}</div>
          </div>
          <div class="batch-item-side">
            <span class="batch-item-status ${statusClass}">${STATUS_TEXT[item.status]}</span>
            <div class="batch-item-actions">${actionHtml}</div>
          </div>
        </div>
      </div>`;
  }

  /**
   * 高频更新单条任务进度，避免整条列表重绘
   */
  updateItemProgress(item) {
    const row = this.els.list.querySelector(`.batch-item[data-id="${item.id}"]`);
    if (!row) {
      this.renderList();
      return;
    }

    const fill = row.querySelector('.batch-item-progress-fill');
    const stage = row.querySelector('.batch-item-stage');
    if (fill) fill.style.width = `${item.progress || 0}%`;
    if (stage && item.stage) stage.textContent = item.stage;
  }

  formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  formatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
