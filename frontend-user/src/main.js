import { AudioAnalyzer } from './modules/audioAnalyzer.js';
import { ChartManager } from './modules/chartManager.js';
import { UIController } from './modules/uiController.js';
import { RecordManager } from './modules/recordManager.js';
import { BatchQueueStorage } from './modules/batchQueueStorage.js';
import { BatchQueue, BatchItemStatus } from './modules/batchQueue.js';
import { BatchQueueUI } from './modules/batchQueueUI.js';
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
    this.audioBuffer = null;
    this.audioContext = null;
    this.currentAnalysisResult = null;
    this.currentFileName = '';
    this.selectedRecordId = null;

    // 批量分析队列
    this.batchQueue = null;
    this.batchUI = null;
    // 本次会话已解码的音频缓存，避免查看结果时重复解码
    this.batchBufferCache = new Map();
    this.batchDataCache = new Map();
    // 为队列条目创建的 ObjectURL，移除时释放
    this.batchObjectUrls = new Map();
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

      // 初始化批量队列（存储恢复 + 状态机 + 界面）
      const batchStorage = new BatchQueueStorage();
      this.batchQueue = new BatchQueue(batchStorage, {
        decodeFile: (file) => this.decodeBatchFile(file),
        analyze: (data, sampleRate, fftSize, onProgress) =>
          this.audioAnalyzer.analyze(data, sampleRate, fftSize, onProgress)
      });
      this.bindBatchQueueEvents();
      await this.batchQueue.restore();
      this.batchUI = new BatchQueueUI(this.batchQueue, {
        onAddFiles: (files) => this.addBatchFiles(files),
        onStart: () => this.startBatchAnalysis(),
        onRetry: (id) => this.batchQueue.retryItem(id),
        onRemove: (id) => this.removeBatchItem(id),
        onView: (id) => this.viewBatchItem(id),
        onClearCompleted: () => this.clearBatchCompleted(),
        onClearAll: () => this.clearBatchAll(),
        onDismissResume: () => this.batchUI.dismissResume()
      });

      // 绑定事件
      this.bindEvents();

      // 加载历史记录列表
      this.updateRecordsList();

      logger.info('应用初始化完成');
    } catch (error) {
      logger.error('应用初始化失败', error);
      alert('应用初始化失败，请刷新页面重试');
    }
  }

  bindBatchQueueEvents() {
    this.batchQueue.subscribe((event) => {
      switch (event.type) {
        case 'run-start':
          this.setBatchRunningUI(true);
          break;
        case 'run-end': {
          this.setBatchRunningUI(false);
          const { processed, succeeded, failed } = event.payload || {};
          if (processed > 0) {
            if (failed > 0) {
              this.uiController.showToast(
                `批量分析结束：成功 ${succeeded} 条，失败 ${failed} 条，失败项可单独重试`,
                failed > 0 ? 'warning' : 'success'
              );
            } else {
              this.uiController.showToast(`批量分析全部完成，共 ${succeeded} 条`, 'success');
            }
          }
          break;
        }
        case 'item-completed':
          // 逐条完成即展示最新结果，已完成结果同时已持久化
          this.handleBatchItemCompleted(event.item, event.payload);
          break;
        case 'item-removed':
          this.invalidateBatchCache(event.item.id);
          break;
        case 'cleared':
          // 清空后统一清理缓存
          for (const id of [...this.batchObjectUrls.keys()]) {
            this.invalidateBatchCache(id);
          }
          break;
        default:
          break;
      }
    });
  }

  /**
   * 批量分析运行期间禁用相关交互，避免重复触发
   */
  setBatchRunningUI(running) {
    document.body.classList.toggle('batch-running', running);

    const ids = ['analyzeBtn', 'removeFile', 'fftSize', 'startTime', 'endTime'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = running;
    });

    const uploadArea = document.getElementById('uploadArea');
    uploadArea.classList.toggle('is-disabled', running);
    uploadArea.style.pointerEvents = running ? 'none' : '';
  }

  async addBatchFiles(files) {
    const fftSize = parseInt(document.getElementById('fftSize').value);
    try {
      const { added, skipped } = await this.batchQueue.addFiles(files, fftSize);
      if (added > 0) {
        this.uiController.showToast(`已加入 ${added} 条音频到批量队列`, 'success');
      }
      if (skipped > 0) {
        this.uiController.showToast(`已跳过 ${skipped} 个非音频文件`, 'warning');
      }
    } catch (error) {
      logger.error('添加批量文件失败', error);
      this.uiController.showToast('添加文件失败：' + (error.message || '存储不可用'), 'error');
    }
  }

  async startBatchAnalysis() {
    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch (error) {
        logger.warn('恢复 AudioContext 失败', error);
      }
    }
    // 开始按钮由队列状态机防重入，重复点击不会触发多次
    await this.batchQueue.start();
  }

  decodeBatchFile(file) {
    return file.arrayBuffer().then(buffer => this.audioContext.decodeAudioData(buffer));
  }

  handleBatchItemCompleted(item, payload) {
    if (payload) {
      if (payload.audioBuffer) this.batchBufferCache.set(item.id, payload.audioBuffer);
      if (payload.audioData) this.batchDataCache.set(item.id, payload.audioData);
    }
    // 自动展示最新完成的分析结果
    this.presentBatchResult(item, payload ? payload.audioBuffer : null, payload ? payload.audioData : null);
  }

  /**
   * 查看队列中已完成条目的分析结果（支持关闭页面后恢复的结果）
   */
  async viewBatchItem(id) {
    const item = this.batchQueue.getItem(id);
    if (!item || item.status !== BatchItemStatus.SUCCESS || !item.analysisResult) {
      this.uiController.showToast('该条目暂无分析结果', 'warning');
      return;
    }

    let audioBuffer = this.batchBufferCache.get(id) || null;
    let audioData = this.batchDataCache.get(id) || null;

    // 恢复会话：从 IndexedDB 读取文件 Blob 并解码
    if (!audioBuffer) {
      try {
        this.uiController.showLoading('正在加载音频与分析结果...');
        const file = await this.batchQueue.storage.getFile(id);
        if (file) {
          audioBuffer = await this.decodeBatchFile(file);
          audioData = audioBuffer.getChannelData(0).slice(0);
          this.batchBufferCache.set(id, audioBuffer);
          this.batchDataCache.set(id, audioData);
        }
      } catch (error) {
        logger.error('加载批量结果音频失败', error);
        this.uiController.showToast('音频文件解码失败，仅展示分析数据', 'warning');
      } finally {
        this.uiController.hideLoading();
      }
    }

    this.presentBatchResult(item, audioBuffer, audioData);
  }

  /**
   * 将队列条目的结果呈现到主图表区与保存区
   */
  presentBatchResult(item, audioBuffer, audioData) {
    const result = item.analysisResult;
    const sampleRate = item.sampleRate || (audioBuffer ? audioBuffer.sampleRate : 44100);
    const waveformData = audioData || new Float32Array(1000).fill(0);

    this.currentAnalysisResult = result;
    this.currentFileName = item.fileName;
    this.batchViewingItemId = item.id;

    this.chartManager.updateAllCharts(result, waveformData, sampleRate);
    this.updateFundamentalInfo(result);

    document.getElementById('chartContainer').style.display = 'flex';
    document.getElementById('emptyState').style.display = 'none';

    // 同步区间显示
    if (item.durationMs) {
      const startInput = document.getElementById('startTime');
      const endInput = document.getElementById('endTime');
      startInput.max = item.durationMs;
      endInput.max = item.durationMs;
      startInput.value = item.startMs || 0;
      endInput.value = item.endMs || item.durationMs;
      this.updateRangeSlider();
    }

    // 支持把批量结果保存为历史记录
    document.getElementById('saveRecordSection').style.display = 'block';
    document.getElementById('recordName').value =
      `${item.fileName} - ${this.recordManager.formatTimestamp()}`;
    document.getElementById('recordNote').value = '';

    // 如有可用音频，提供播放（从存储获取 Blob；失败不影响图表结果展示）
    const playerSection = document.getElementById('audioPlayerSection');
    const player = document.getElementById('audioPlayer');
    if (audioBuffer) {
      document.getElementById('totalDuration').textContent = audioBuffer.duration.toFixed(3);
      playerSection.style.display = 'block';
      this.batchQueue.storage.getFile(item.id).then(fileBlob => {
        if (!fileBlob) return;
        const old = this.batchObjectUrls.get(item.id);
        if (old) URL.revokeObjectURL(old);
        const url = URL.createObjectURL(fileBlob);
        this.batchObjectUrls.set(item.id, url);
        player.src = url;
      }).catch(() => {});
    }
  }

  invalidateBatchCache(id) {
    this.batchBufferCache.delete(id);
    this.batchDataCache.delete(id);
    const url = this.batchObjectUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      this.batchObjectUrls.delete(id);
    }
  }

  async removeBatchItem(id) {
    this.invalidateBatchCache(id);
    await this.batchQueue.removeItem(id);
    this.uiController.showToast('已从队列移除', 'info');
  }

  async clearBatchCompleted() {
    const { success } = this.batchQueue.getStats();
    if (success === 0) return;
    for (const item of this.batchQueue.items.filter(i => i.status === BatchItemStatus.SUCCESS)) {
      this.invalidateBatchCache(item.id);
    }
    await this.batchQueue.clearCompleted();
    this.uiController.showToast('已清空完成的任务', 'success');
  }

  async clearBatchAll() {
    if (this.batchQueue.running) return;
    const { total } = this.batchQueue.getStats();
    if (total === 0) return;
    if (!confirm('确定要清空整个批量队列吗？已完成的分析结果也会被删除，此操作不可恢复。')) {
      return;
    }
    for (const id of [...this.batchObjectUrls.keys()]) {
      this.invalidateBatchCache(id);
    }
    await this.batchQueue.clearAll();
    this.uiController.showToast('批量队列已清空', 'info');
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

    // 记录相关事件
    this.bindRecordEvents();
  }

  async handleFileUpload(file) {
    if (this.batchQueue && this.batchQueue.running) {
      this.uiController.showToast('批量分析进行中，暂时无法更换音频', 'warning');
      return;
    }

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
    if (this.batchQueue && this.batchQueue.running) {
      this.uiController.showToast('批量分析进行中，请等待完成', 'warning');
      return;
    }

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

      // 更新图表
      this.chartManager.updateAllCharts(analysisResult, selectedData, this.audioBuffer.sampleRate);

      // 更新基频信息
      this.updateFundamentalInfo(analysisResult);

      // 显示图表区域
      document.getElementById('chartContainer').style.display = 'flex';
      document.getElementById('emptyState').style.display = 'none';

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

    const fakeAudioData = new Float32Array(1000).fill(0);
    const sampleRate = 44100;
    this.chartManager.updateAllCharts(record.analysisResult, fakeAudioData, sampleRate);
    this.updateFundamentalInfo(record.analysisResult);

    document.getElementById('chartContainer').style.display = 'flex';
    document.getElementById('emptyState').style.display = 'none';

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
