import { AudioAnalyzer } from './modules/audioAnalyzer.js';
import { ChartManager } from './modules/chartManager.js';
import { UIController } from './modules/uiController.js';
import { RecordManager } from './modules/recordManager.js';
import { BatchQueueManager, BatchStatus } from './modules/batchQueueManager.js';
import { Logger } from './utils/logger.js';

// 初始化日志
const logger = new Logger('Main');

// 应用初始化
class App {
  constructor() {
    this.audioAnalyzer = null;
    this.chartManager = null;
    this.uiController = null;
    this.recordManager = null;
    this.batchQueue = null;
    this.batchRunning = false;
    this.audioBuffer = null;
    this.audioContext = null;
    this.currentAnalysisResult = null;
    this.currentFileName = '';
    this.selectedRecordId = null;
  }

  async init() {
    logger.info('应用初始化开始');

    try {
      // 初始化 AudioContext
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      // 初始化模块
      this.audioAnalyzer = new AudioAnalyzer(this.audioContext);
      this.chartManager = new ChartManager();
      this.uiController = new UIController();
      this.recordManager = new RecordManager();

      // 初始化批量分析队列（从 IndexedDB 恢复上次未完成的队列）
      this.batchQueue = new BatchQueueManager();
      await this.batchQueue.init();
      this.batchQueue.onChange((event) => this.handleBatchEvent(event));

      // 绑定事件
      this.bindEvents();

      // 加载历史记录列表
      this.updateRecordsList();

      // 恢复批量队列界面
      this.renderBatchQueue();
      const batchSummary = this.batchQueue.getSummary();
      if (batchSummary.total > 0) {
        const parts = [];
        if (batchSummary.done > 0) parts.push(`${batchSummary.done} 条已完成`);
        if (batchSummary.failed > 0) parts.push(`${batchSummary.failed} 条失败`);
        if (batchSummary.pending > 0) parts.push(`${batchSummary.pending} 条待分析`);
        this.uiController.showToast(`已恢复上次的批量分析队列（${parts.join('，')}）`, 'info');
      }

      logger.info('应用初始化完成');
    } catch (error) {
      logger.error('应用初始化失败', error);
      alert('应用初始化失败，请刷新页面重试');
    }
  }

  bindEvents() {
    // 文件上传
    const uploadArea = document.getElementById('uploadArea');
    const audioInput = document.getElementById('audioInput');
    const removeFile = document.getElementById('removeFile');

    uploadArea.addEventListener('click', () => audioInput.click());
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) this.handleFileUpload(file);
    });

    audioInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.handleFileUpload(file);
    });

    removeFile.addEventListener('click', () => this.removeAudioFile());

    // 区间选择
    const startTime = document.getElementById('startTime');
    const endTime = document.getElementById('endTime');
    startTime.addEventListener('input', () => this.updateRangeSlider());
    endTime.addEventListener('input', () => this.updateRangeSlider());

    // 范围滑块拖拽
    this.initRangeSlider();

    // 分析按钮
    const analyzeBtn = document.getElementById('analyzeBtn');
    analyzeBtn.addEventListener('click', () => this.analyzeAudio());

    // 批量分析队列事件
    this.bindBatchEvents();

    // 记录相关事件
    this.bindRecordEvents();
  }

  async handleFileUpload(file) {
    // 验证文件类型
    if (!file.type.startsWith('audio/')) {
      alert('请上传有效的音频文件');
      return;
    }

    this.currentFileName = file.name;
    logger.info('开始加载音频文件', { name: file.name, size: file.size });

    try {
      // 显示加载状态
      this.uiController.showLoading('正在加载音频...');

      // 读取文件
      const arrayBuffer = await file.arrayBuffer();
      
      // 解码音频
      this.audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

      // 更新 UI
      const duration = this.audioBuffer.duration;
      const durationMs = Math.floor(duration * 1000);

      document.getElementById('fileName').textContent = file.name;
      document.getElementById('fileInfo').style.display = 'flex';
      document.getElementById('uploadArea').style.display = 'none';

      // 设置音频播放器
      const audioPlayer = document.getElementById('audioPlayer');
      audioPlayer.src = URL.createObjectURL(file);
      document.getElementById('audioPlayerSection').style.display = 'block';
      document.getElementById('totalDuration').textContent = duration.toFixed(3);

      // 设置区间选择
      document.getElementById('startTime').value = 0;
      document.getElementById('startTime').max = durationMs;
      document.getElementById('endTime').value = durationMs;
      document.getElementById('endTime').max = durationMs;

      this.updateRangeSlider();

      // 启用分析按钮
      document.getElementById('analyzeBtn').disabled = false;

      logger.info('音频文件加载成功', { duration, sampleRate: this.audioBuffer.sampleRate });
    } catch (error) {
      logger.error('音频文件加载失败', error);
      alert('音频文件加载失败，请确保文件格式正确');
    } finally {
      this.uiController.hideLoading();
    }
  }

  removeAudioFile() {
    this.audioBuffer = null;
    this.currentAnalysisResult = null;
    this.currentFileName = '';
    document.getElementById('audioInput').value = '';
    document.getElementById('fileInfo').style.display = 'none';
    document.getElementById('uploadArea').style.display = 'block';
    document.getElementById('audioPlayerSection').style.display = 'none';
    document.getElementById('analyzeBtn').disabled = true;
    document.getElementById('chartContainer').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('fundamentalInfo').style.display = 'none';
    document.getElementById('saveRecordSection').style.display = 'none';
    
    // 清除图表
    this.chartManager.clearAllCharts();

    logger.info('音频文件已移除');
  }

  initRangeSlider() {
    const track = document.getElementById('rangeTrack');
    const handleStart = document.getElementById('handleStart');
    const handleEnd = document.getElementById('handleEnd');
    let isDragging = null;

    const updateFromSlider = (clientX) => {
      const rect = track.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const maxMs = parseInt(document.getElementById('endTime').max) || 1000;
      const value = Math.round(percent * maxMs);

      if (isDragging === 'start') {
        const endValue = parseInt(document.getElementById('endTime').value);
        if (value < endValue) {
          document.getElementById('startTime').value = value;
        }
      } else if (isDragging === 'end') {
        const startValue = parseInt(document.getElementById('startTime').value);
        if (value > startValue) {
          document.getElementById('endTime').value = value;
        }
      }

      this.updateRangeSlider();
    };

    handleStart.addEventListener('mousedown', () => isDragging = 'start');
    handleEnd.addEventListener('mousedown', () => isDragging = 'end');

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        updateFromSlider(e.clientX);
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = null;
    });
  }

  updateRangeSlider() {
    let startTime = parseInt(document.getElementById('startTime').value) || 0;
    let endTime = parseInt(document.getElementById('endTime').value) || 0;
    const maxTime = parseInt(document.getElementById('endTime').max) || 1000;

    // 确保起始时间不大于结束时间
    if (startTime > endTime) {
      // 交换值
      const temp = startTime;
      startTime = endTime;
      endTime = temp;
      document.getElementById('startTime').value = startTime;
      document.getElementById('endTime').value = endTime;
    }

    // 确保值在有效范围内
    startTime = Math.max(0, Math.min(startTime, maxTime));
    endTime = Math.max(0, Math.min(endTime, maxTime));

    const startPercent = (startTime / maxTime) * 100;
    const endPercent = (endTime / maxTime) * 100;

    document.getElementById('handleStart').style.left = `${startPercent}%`;
    document.getElementById('handleEnd').style.left = `${endPercent}%`;
    document.getElementById('rangeSelected').style.left = `${startPercent}%`;
    document.getElementById('rangeSelected').style.width = `${Math.max(0, endPercent - startPercent)}%`;

    const durationSec = Math.max(0, endTime - startTime) / 1000;
    document.getElementById('selectedDuration').textContent = durationSec.toFixed(3);
  }

  async analyzeAudio() {
    if (!this.audioBuffer) {
      alert('请先上传音频文件');
      return;
    }

    const startMs = parseInt(document.getElementById('startTime').value) || 0;
    const endMs = parseInt(document.getElementById('endTime').value) || 0;

    if (startMs >= endMs) {
      alert('请选择有效的时间区间');
      return;
    }

    logger.info('开始分析音频', { startMs, endMs });

    try {
      this.uiController.showLoading('正在分析音频...');

      // 获取 FFT 大小
      const fftSize = parseInt(document.getElementById('fftSize').value);

      // 提取选定区间的音频数据
      const startSample = Math.floor((startMs / 1000) * this.audioBuffer.sampleRate);
      const endSample = Math.floor((endMs / 1000) * this.audioBuffer.sampleRate);
      const channelData = this.audioBuffer.getChannelData(0);
      const selectedData = channelData.slice(startSample, endSample);

      // 分析音频
      const analysisResult = await this.audioAnalyzer.analyze(selectedData, this.audioBuffer.sampleRate, fftSize);

      logger.info('音频分析完成', { 
        fundamentalFreq: analysisResult.fundamentalFreq,
        harmonicsCount: analysisResult.harmonics.length 
      });

      // 保存当前分析结果
      this.currentAnalysisResult = analysisResult;

      // 先显示图表区域再绘图，否则容器隐藏时 canvas 尺寸计算为 0（热力图无法正确绘制）
      document.getElementById('chartContainer').style.display = 'flex';
      document.getElementById('emptyState').style.display = 'none';

      // 更新图表
      this.chartManager.updateAllCharts(analysisResult, selectedData, this.audioBuffer.sampleRate);

      // 更新基频信息
      this.updateFundamentalInfo(analysisResult);

      // 显示保存记录区域
      document.getElementById('saveRecordSection').style.display = 'block';
      document.getElementById('recordName').value = `${this.currentFileName} - ${this.recordManager.formatTimestamp()}`;
      document.getElementById('recordNote').value = '';

    } catch (error) {
      logger.error('音频分析失败', error);
      alert('音频分析失败: ' + error.message);
    } finally {
      this.uiController.hideLoading();
    }
  }

  updateFundamentalInfo(result) {
    document.getElementById('fundamentalInfo').style.display = 'block';
    document.getElementById('fundamentalFreq').textContent = result.fundamentalFreq.toFixed(2);

    const harmonicsList = document.getElementById('harmonicsList');
    harmonicsList.innerHTML = result.harmonics.map((h, i) => `
      <div class="harmonic-item">
        <span class="harmonic-label">${i + 2}倍频</span>
        <span class="harmonic-freq">${h.toFixed(1)} Hz</span>
      </div>
    `).join('');
  }

  /* ================= 批量分析队列 ================= */

  bindBatchEvents() {
    const panel = document.getElementById('batchQueuePanel');
    const addBtn = document.getElementById('batchAddBtn');
    const fileInput = document.getElementById('batchFileInput');
    const startBtn = document.getElementById('batchStartBtn');
    const clearDoneBtn = document.getElementById('batchClearDoneBtn');
    const clearAllBtn = document.getElementById('batchClearAllBtn');
    const listEl = document.getElementById('batchList');

    // 一次挑选多条音频加入队列
    addBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.addBatchFiles(e.target.files);
      }
      fileInput.value = '';
    });

    // 拖拽多个文件到队列面板
    panel.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!this.batchRunning) {
        panel.classList.add('dragover');
      }
    });
    panel.addEventListener('dragleave', () => panel.classList.remove('dragover'));
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      panel.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        this.addBatchFiles(e.dataTransfer.files);
      }
    });

    // 队列控制
    startBtn.addEventListener('click', () => this.startBatchQueue());
    clearDoneBtn.addEventListener('click', async () => {
      if (this.batchRunning) return;
      const removed = await this.batchQueue.clearCompleted();
      this.uiController.showToast(
        removed > 0 ? `已清除 ${removed} 条已完成的任务` : '没有已完成的任务',
        removed > 0 ? 'success' : 'info'
      );
    });
    clearAllBtn.addEventListener('click', async () => {
      if (this.batchRunning) return;
      if (this.batchQueue.getItems().length === 0) return;
      if (confirm('确定要清空整个分析队列吗？已完成的结果也会被删除。')) {
        await this.batchQueue.clearAll();
        this.uiController.showToast('队列已清空', 'success');
      }
    });

    // 队列项操作（事件委托：重试 / 移除 / 查看结果）
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const itemEl = btn.closest('.batch-item');
      const id = itemEl ? itemEl.dataset.id : null;
      if (!id) return;
      const action = btn.dataset.action;
      if (action === 'retry') this.retryBatchItem(id);
      else if (action === 'remove') this.removeBatchItem(id);
      else if (action === 'view') this.viewBatchResult(id);
    });
  }

  async addBatchFiles(files) {
    if (this.batchRunning) {
      this.uiController.showToast('批量分析运行中，请等待当前队列完成后再添加', 'warning');
      return;
    }
    if (!files || files.length === 0) return;

    const fftSize = parseInt(document.getElementById('fftSize').value);
    const { added, skipped, oversized, failed } = await this.batchQueue.addFiles(files, { fftSize });

    const messages = [];
    if (added > 0) messages.push(`已加入 ${added} 条`);
    if (skipped > 0) messages.push(`跳过 ${skipped} 个非音频文件`);
    if (oversized > 0) messages.push(`跳过 ${oversized} 个超大文件`);
    if (failed > 0) messages.push(`${failed} 个文件加入失败`);
    this.uiController.showToast(messages.join('，') || '没有可加入的文件', added > 0 ? 'success' : 'warning');

    if (added > 0 && !this.batchQueue.persistent) {
      this.uiController.showToast('当前浏览器环境不支持持久化存储，刷新页面后队列将无法恢复', 'warning');
    }
  }

  handleBatchEvent(event) {
    if (event.type === 'progress') {
      // 单条进度：只更新对应进度条与整体进度，避免频繁重绘列表
      this.updateBatchProgressDOM(event.id, event.progress);
    } else {
      this.renderBatchQueue();
    }
  }

  /**
   * 启动队列：逐条自动分析，单条失败不中断后续任务
   */
  async startBatchQueue() {
    if (this.batchRunning) return;
    if (!this.batchQueue.getNextPending()) {
      this.uiController.showToast('队列中没有待分析的任务', 'info');
      return;
    }

    logger.info('开始批量分析队列');
    this.batchRunning = true;
    this.setBatchRunningUI(true);

    const summary = { done: 0, failed: 0 };
    try {
      let item;
      while ((item = this.batchQueue.getNextPending())) {
        const success = await this.processBatchItem(item);
        if (success) summary.done++;
        else summary.failed++;
      }
    } finally {
      this.batchRunning = false;
      this.setBatchRunningUI(false);
    }

    logger.info('批量分析队列结束', summary);
    if (summary.failed > 0) {
      this.uiController.showToast(`批量分析完成：${summary.done} 条成功，${summary.failed} 条失败（可在队列中单独重试）`, 'warning');
    } else {
      this.uiController.showToast(`批量分析完成：${summary.done} 条全部成功`, 'success');
    }
  }

  /**
   * 分析单条队列任务，失败时标记并返回 false，不抛出异常
   */
  async processBatchItem(item) {
    const items = this.batchQueue.getItems();
    const index = items.findIndex(i => i.id === item.id) + 1;
    this.updateBatchStatusText(`正在分析 (${index}/${items.length})：${item.fileName}`);
    this.batchQueue.updateItem(item.id, {
      status: BatchStatus.ANALYZING,
      progress: 2,
      error: null,
      interrupted: false
    });

    try {
      // 读取文件数据
      const blob = await this.batchQueue.getFileData(item.id);
      if (!blob) {
        throw new Error('文件数据已丢失，请移除后重新添加');
      }
      this.batchQueue.updateItem(item.id, { progress: 8 }, { persist: false, progressEvent: true });

      // 解码音频
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      this.batchQueue.updateItem(item.id, { progress: 15, duration: audioBuffer.duration });

      // 逐条分析（带进度回调，分析期间让出主线程以刷新界面）
      const channelData = audioBuffer.getChannelData(0);
      const fftSize = (item.params && item.params.fftSize) || parseInt(document.getElementById('fftSize').value);
      const result = await this.audioAnalyzer.analyze(
        channelData,
        audioBuffer.sampleRate,
        fftSize,
        (p) => {
          this.batchQueue.updateItem(item.id, { progress: 15 + Math.round(p * 80) }, { persist: false, progressEvent: true });
        }
      );

      // 保存分析结果
      this.batchQueue.updateItem(item.id, { progress: 97 }, { persist: false, progressEvent: true });
      this.batchQueue.updateItem(item.id, {
        status: BatchStatus.DONE,
        progress: 100,
        result,
        error: null
      });
      // 结果已保存，释放原始音频数据占用的存储空间
      await this.batchQueue.discardFile(item.id);

      logger.info('批量任务分析完成', { fileName: item.fileName, fundamentalFreq: result.fundamentalFreq });
      return true;
    } catch (error) {
      // 单条失败：标记出来，由队列继续处理后续任务
      logger.error('批量任务分析失败', { fileName: item.fileName, message: error.message });
      this.batchQueue.updateItem(item.id, {
        status: BatchStatus.FAILED,
        error: error.message || '分析失败'
      });
      return false;
    }
  }

  /**
   * 单独重试某条失败的任务
   */
  async retryBatchItem(id) {
    if (this.batchRunning) return;
    const item = this.batchQueue.getItem(id);
    if (!item || item.status !== BatchStatus.FAILED) return;

    logger.info('单独重试批量任务', { fileName: item.fileName });
    this.batchQueue.updateItem(id, { status: BatchStatus.PENDING, progress: 0, error: null });

    this.batchRunning = true;
    this.setBatchRunningUI(true);
    try {
      const success = await this.processBatchItem(this.batchQueue.getItem(id));
      const latest = this.batchQueue.getItem(id);
      if (success) {
        this.uiController.showToast(`「${item.fileName}」重试成功`, 'success');
      } else {
        this.uiController.showToast(`「${item.fileName}」重试失败：${latest ? latest.error : ''}`, 'error');
      }
    } finally {
      this.batchRunning = false;
      this.setBatchRunningUI(false);
    }
  }

  async removeBatchItem(id) {
    if (this.batchRunning) return;
    const item = this.batchQueue.getItem(id);
    if (!item) return;
    await this.batchQueue.removeItem(id);
    this.uiController.showToast(`已移除「${item.fileName}」`, 'info');
  }

  /**
   * 查看已完成任务的分析结果（加载到图表区域，可另存为记录）
   */
  viewBatchResult(id) {
    const item = this.batchQueue.getItem(id);
    if (!item || item.status !== BatchStatus.DONE || !item.result) return;

    this.currentAnalysisResult = item.result;
    this.currentFileName = item.fileName;

    // 先显示图表区域再绘图，否则容器隐藏时 canvas 尺寸计算为 0（热力图无法正确绘制）
    document.getElementById('chartContainer').style.display = 'flex';
    document.getElementById('emptyState').style.display = 'none';

    // 与"应用历史记录"一致：结果中不含原始波形，波形图使用占位数据
    const fakeAudioData = new Float32Array(1000).fill(0);
    this.chartManager.updateAllCharts(item.result, fakeAudioData, 44100);
    this.updateFundamentalInfo(item.result);

    document.getElementById('saveRecordSection').style.display = 'block';
    document.getElementById('recordName').value = `${item.fileName} - ${this.recordManager.formatTimestamp()}`;
    document.getElementById('recordNote').value = '';

    this.uiController.showToast(`已加载「${item.fileName}」的分析结果`, 'success');
  }

  /**
   * 批量运行期间：给出清楚的加载提示，并禁用按钮等交互元素，避免重复触发
   */
  setBatchRunningUI(running) {
    document.body.classList.toggle('batch-running', running);

    // 禁用/恢复单条分析相关交互
    document.getElementById('analyzeBtn').disabled = running || !this.audioBuffer;
    document.getElementById('fftSize').disabled = running;
    document.getElementById('startTime').disabled = running;
    document.getElementById('endTime').disabled = running;

    // 运行状态提示
    document.getElementById('batchRunningStatus').style.display = running ? 'flex' : 'none';
    if (!running) {
      this.updateBatchStatusText('');
    }

    // 刷新队列内按钮的禁用状态
    this.renderBatchQueue();
  }

  updateBatchStatusText(text) {
    document.getElementById('batchStatusText').textContent = text;
  }

  updateBatchProgressDOM(id, progress) {
    const itemEl = document.querySelector(`.batch-item[data-id="${id}"]`);
    if (itemEl) {
      const fill = itemEl.querySelector('.batch-item-progress-fill');
      if (fill) {
        fill.style.width = `${progress}%`;
      }
    }
    // 整体进度条同步推进
    this.renderBatchOverall();
  }

  renderBatchOverall() {
    const summary = this.batchQueue.getSummary();
    const overallEl = document.getElementById('batchOverall');

    if (summary.total === 0) {
      overallEl.style.display = 'none';
      return;
    }
    overallEl.style.display = 'block';

    const parts = [`总进度 ${summary.done + summary.failed}/${summary.total}`];
    if (summary.failed > 0) parts.push(`${summary.failed} 条失败`);
    if (summary.pending > 0) parts.push(`${summary.pending} 条待分析`);
    document.getElementById('batchOverallText').textContent = parts.join(' · ');
    document.getElementById('batchOverallPercent').textContent = `${summary.overall}%`;

    const fill = document.getElementById('batchOverallFill');
    fill.style.width = `${summary.overall}%`;
    fill.classList.toggle('complete', summary.pending === 0 && summary.analyzing === 0);
  }

  renderBatchQueue() {
    const items = this.batchQueue.getItems();
    const summary = this.batchQueue.getSummary();
    const running = this.batchRunning;

    const listEl = document.getElementById('batchList');
    const emptyEl = document.getElementById('batchEmpty');
    const footerEl = document.getElementById('batchFooter');

    if (items.length === 0) {
      // 空队列：显示说明
      listEl.style.display = 'none';
      emptyEl.style.display = 'flex';
      footerEl.style.display = 'none';
    } else {
      listEl.style.display = 'flex';
      emptyEl.style.display = 'none';
      footerEl.style.display = 'flex';
      listEl.innerHTML = items.map(item => this.renderBatchItem(item)).join('');
    }

    this.renderBatchOverall();

    // 控制按钮状态（运行中全部禁用，避免重复触发）
    document.getElementById('batchAddBtn').disabled = running;
    document.getElementById('batchStartBtn').disabled = running || summary.pending === 0;
    document.getElementById('batchClearDoneBtn').disabled = running || summary.done === 0;
    document.getElementById('batchClearAllBtn').disabled = running || items.length === 0;
  }

  renderBatchItem(item) {
    const statusMap = {
      [BatchStatus.PENDING]: { text: item.interrupted ? '等待中 · 已恢复' : '等待中', className: 'pending' },
      [BatchStatus.ANALYZING]: { text: '分析中', className: 'analyzing' },
      [BatchStatus.DONE]: { text: '已完成', className: 'done' },
      [BatchStatus.FAILED]: { text: '失败', className: 'failed' }
    };
    const status = statusMap[item.status];
    const disabledAttr = this.batchRunning ? 'disabled' : '';

    const metaParts = [];
    if (item.fileSize) metaParts.push(this.formatFileSize(item.fileSize));
    if (item.duration) metaParts.push(`${item.duration.toFixed(2)} 秒`);
    if (item.status === BatchStatus.DONE && item.result) {
      metaParts.push(`基频 ${item.result.fundamentalFreq.toFixed(1)} Hz`);
    }

    return `
      <div class="batch-item status-${status.className}" data-id="${item.id}">
        <div class="batch-item-main">
          <span class="batch-item-name" title="${this.escapeHtml(item.fileName)}">${this.escapeHtml(this.truncateText(item.fileName, 20))}</span>
          <span class="batch-item-badge ${status.className}">${status.text}</span>
        </div>
        <div class="batch-item-meta">${this.escapeHtml(metaParts.join(' · '))}</div>
        <div class="batch-item-progress">
          <div class="batch-item-progress-fill" style="width: ${item.progress}%"></div>
        </div>
        ${item.status === BatchStatus.FAILED ? `
          <div class="batch-item-error" title="${this.escapeHtml(item.error || '')}">⚠ ${this.escapeHtml(item.error || '分析失败')}</div>
        ` : ''}
        <div class="batch-item-actions">
          ${item.status === BatchStatus.DONE ? `<button class="batch-item-btn view" data-action="view" ${disabledAttr}>查看结果</button>` : ''}
          ${item.status === BatchStatus.FAILED ? `<button class="batch-item-btn retry" data-action="retry" ${disabledAttr}>↻ 重试</button>` : ''}
          ${item.status !== BatchStatus.ANALYZING
            ? `<button class="batch-item-btn remove" data-action="remove" title="移除" ${disabledAttr}>✕</button>`
            : '<span class="batch-item-spinner" title="分析中"></span>'}
        </div>
      </div>
    `;
  }

  formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  bindRecordEvents() {
    // 保存记录按钮
    document.getElementById('saveRecordBtn').addEventListener('click', () => this.saveRecord());

    // 展开/收起记录列表
    document.getElementById('toggleRecordsBtn').addEventListener('click', () => this.toggleRecordsPanel());

    // 关闭模态框
    document.getElementById('closeModalBtn').addEventListener('click', () => this.closeRecordModal());
    document.getElementById('recordDetailModal').addEventListener('click', (e) => {
      if (e.target.id === 'recordDetailModal') {
        this.closeRecordModal();
      }
    });

    // 应用记录
    document.getElementById('applyRecordBtn').addEventListener('click', () => this.applyRecord());

    // 删除记录
    document.getElementById('deleteRecordBtn').addEventListener('click', () => this.deleteRecord());
  }

  saveRecord() {
    if (!this.currentAnalysisResult) {
      this.uiController.showToast('没有可保存的分析结果', 'warning');
      return;
    }

    const name = document.getElementById('recordName').value.trim();
    const note = document.getElementById('recordNote').value.trim();
    const startMs = parseInt(document.getElementById('startTime').value) || 0;
    const endMs = parseInt(document.getElementById('endTime').value) || 0;

    const harmonicIntensities = this.extractHarmonicIntensities(this.currentAnalysisResult);

    try {
      const record = this.recordManager.createRecord({
        fileName: this.currentFileName,
        startMs,
        endMs,
        fundamentalFreq: this.currentAnalysisResult.fundamentalFreq,
        harmonics: this.currentAnalysisResult.harmonics,
        harmonicIntensities,
        analysisResult: this.currentAnalysisResult,
        name: name
      });

      if (note) {
        this.recordManager.updateRecord(record.id, { note });
      }

      this.uiController.showToast('记录保存成功', 'success');
      this.updateRecordsList();
    } catch (error) {
      this.uiController.showToast(error.message, 'error');
    }
  }

  extractHarmonicIntensities(analysisResult) {
    const { fundamentalFreq, harmonics, frequencies, magnitudes } = analysisResult;
    const allHarmonics = [fundamentalFreq, ...harmonics];
    const intensities = {};

    allHarmonics.forEach((harmonic, index) => {
      let closestMag = 0;
      let minDist = Infinity;

      for (let i = 0; i < frequencies.length; i++) {
        const dist = Math.abs(frequencies[i] - harmonic);
        if (dist < minDist) {
          minDist = dist;
          closestMag = magnitudes[i];
        }
      }

      const key = index === 0 ? 'fundamental' : `harmonic${index + 1}`;
      intensities[key] = closestMag;
    });

    const maxMag = Math.max(...Object.values(intensities));
    const normalizedIntensities = {};
    Object.keys(intensities).forEach(key => {
      normalizedIntensities[key] = maxMag > 0 ? (intensities[key] / maxMag) * 100 : 0;
    });

    return normalizedIntensities;
  }

  updateRecordsList() {
    const records = this.recordManager.getAllRecords();
    const recordsList = document.getElementById('recordsList');
    const recordsEmpty = document.getElementById('recordsEmpty');

    if (records.length === 0) {
      recordsList.style.display = 'none';
      recordsEmpty.style.display = 'flex';
      return;
    }

    recordsList.style.display = 'block';
    recordsEmpty.style.display = 'none';

    recordsList.innerHTML = records.map(record => `
      <div class="record-item" data-id="${record.id}">
        <div class="record-main">
          <span class="record-name" title="${record.name}">${this.truncateText(record.name, 25)}</span>
          <span class="record-freq">${record.fundamentalFreq.toFixed(1)} Hz</span>
        </div>
        <div class="record-meta">
          <span class="record-file" title="${record.fileName}">${this.truncateText(record.fileName, 20)}</span>
          <span class="record-time">${this.recordManager.formatDate(record.createdAt)}</span>
        </div>
      </div>
    `).join('');

    recordsList.querySelectorAll('.record-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        this.showRecordDetail(id);
      });
    });
  }

  truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  toggleRecordsPanel() {
    const content = document.getElementById('recordsContent');
    const btn = document.getElementById('toggleRecordsBtn');
    
    if (content.style.display === 'none') {
      content.style.display = 'block';
      btn.textContent = '▼';
    } else {
      content.style.display = 'none';
      btn.textContent = '▶';
    }
  }

  showRecordDetail(recordId) {
    const record = this.recordManager.getRecord(recordId);
    if (!record) return;

    this.selectedRecordId = recordId;

    const modalBody = document.getElementById('modalBody');
    document.getElementById('modalTitle').textContent = record.name;

    modalBody.innerHTML = `
      <div class="record-detail">
        <div class="detail-section">
          <h4>基本信息</h4>
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">文件名</span>
              <span class="detail-value">${record.fileName}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">创建时间</span>
              <span class="detail-value">${this.recordManager.formatTimestampFull(record.createdAt)}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">分析区间</span>
              <span class="detail-value">${record.startMs}ms - ${record.endMs}ms (${(record.durationMs / 1000).toFixed(3)}s)</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">基频</span>
              <span class="detail-value highlight">${record.fundamentalFreq.toFixed(2)} Hz</span>
            </div>
          </div>
        </div>
        
        <div class="detail-section">
          <h4>倍频与强度</h4>
          <div class="harmonics-table">
            <div class="table-header">
              <span>谐波</span>
              <span>频率</span>
              <span>相对强度</span>
            </div>
            <div class="table-row">
              <span>基频</span>
              <span>${record.fundamentalFreq.toFixed(1)} Hz</span>
              <span>
                <div class="intensity-bar">
                  <div class="intensity-fill" style="width: ${record.harmonicIntensities?.fundamental || 100}%"></div>
                  <span class="intensity-text">${(record.harmonicIntensities?.fundamental || 100).toFixed(1)}%</span>
                </div>
              </span>
            </div>
            ${record.harmonics.map((h, i) => {
              const intensityKey = `harmonic${i + 2}`;
              const intensity = record.harmonicIntensities?.[intensityKey] || 0;
              return `
                <div class="table-row">
                  <span>${i + 2}倍频</span>
                  <span>${h.toFixed(1)} Hz</span>
                  <span>
                    <div class="intensity-bar">
                      <div class="intensity-fill" style="width: ${intensity}%"></div>
                      <span class="intensity-text">${intensity.toFixed(1)}%</span>
                    </div>
                  </span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        
        ${record.note ? `
          <div class="detail-section">
            <h4>备注</h4>
            <p class="record-note">${record.note}</p>
          </div>
        ` : ''}
      </div>
    `;

    document.getElementById('recordDetailModal').style.display = 'flex';
  }

  closeRecordModal() {
    document.getElementById('recordDetailModal').style.display = 'none';
    this.selectedRecordId = null;
  }

  applyRecord() {
    if (!this.selectedRecordId) return;

    const record = this.recordManager.getRecord(this.selectedRecordId);
    if (!record) return;

    if (!record.analysisResult) {
      this.uiController.showToast('该记录不包含完整的分析数据', 'warning');
      return;
    }

    this.currentAnalysisResult = record.analysisResult;

    // 先显示图表区域再绘图，否则容器隐藏时 canvas 尺寸计算为 0（热力图无法正确绘制）
    document.getElementById('chartContainer').style.display = 'flex';
    document.getElementById('emptyState').style.display = 'none';

    const fakeAudioData = new Float32Array(1000).fill(0);
    const sampleRate = 44100;
    this.chartManager.updateAllCharts(record.analysisResult, fakeAudioData, sampleRate);
    this.updateFundamentalInfo(record.analysisResult);

    this.closeRecordModal();
    this.uiController.showToast('记录已应用', 'success');
  }

  deleteRecord() {
    if (!this.selectedRecordId) return;

    if (confirm('确定要删除这条记录吗？此操作不可恢复。')) {
      const success = this.recordManager.deleteRecord(this.selectedRecordId);
      if (success) {
        this.updateRecordsList();
        this.closeRecordModal();
        this.uiController.showToast('记录已删除', 'success');
      } else {
        this.uiController.showToast('删除失败', 'error');
      }
    }
  }
}

// 启动应用
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
