// 필수 모듈 불러오기
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const tf = require('@tensorflow/tfjs');
const jpeg = require('jpeg-js');
const NodeWebcam = require('node-webcam');
const { Gpio } = require('pigpio');

// IR 센서와 서보모터 준비
const IR = new Gpio(23, { mode: Gpio.INPUT, pullUpDown: Gpio.PUD_DOWN, alert: true });
const servo = new Gpio(18, { mode: Gpio.OUTPUT });

// HTTP/WebSocket 서버 준비
const app = express();
const PORT = 8001;
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ port: 8002 });
const connectedClients = new Set();

// 상태 머신, 타이밍, 복구 정책 상수
const STATES = {
  IDLE: 'IDLE',
  OCCUPIED: 'OCCUPIED',
  ANALYZING: 'ANALYZING',
  CLEANING: 'CLEANING',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR'
};

const CLEANING_STEPS = [
  { atMs: 0, pulse: 500 },
  { atMs: 2000, pulse: 2500 },
  { atMs: 4000, pulse: 1500 }
];
const CLEANING_TOTAL_MS = 10000;
const CLEANING_PAUSE_IGNORE_MS = 4000;
const ERROR_RECOVERY_MS = 10000;
const ACCESS_RISE_DEBOUNCE_MS = 300;
const ACCESS_FALL_DEBOUNCE_MS = 500;
const CAPTURE_RETRY_DELAY_MS = 1000;
const MODEL_RETRY_DELAY_MS = 3000;
const MAX_CAPTURE_RETRIES = 2;
const MAX_CAPTURE_FAILURES_BEFORE_FATAL = 3;
const MAX_MODEL_FAILURES_BEFORE_FATAL = 3;
const MAX_CLEANING_FAILURES_BEFORE_FATAL = 2;
const MODEL_URL = `http://127.0.0.1:${PORT}/tfjs_model/model.json`;
const TEMP_CAPTURE_BASENAME = path.join(__dirname, 'photo_latest');
const TEMP_CAPTURE_PATH = `${TEMP_CAPTURE_BASENAME}.jpg`;

// 프로세스 순서 요약
// 1. 서버를 시작한 뒤 AI 모델을 로딩한다.
// 2. IR 센서에서 원시 접근/이탈 값을 받는다.
// 3. 디바운싱 후 강아지의 올라옴/내려옴을 확정한다.
// 4. 올라옴이 확정되면 감시 상태로 전환하거나 청소 중단 여부를 판단한다.
// 5. 내려옴이 확정되면 사진 촬영과 분석 단계로 넘긴다.
// 6. 최신 사진 한 장만 촬영하고 실패 시 재시도한다.
// 7. AI가 촬영 이미지를 분석해 배설물 유무를 판단한다.
// 8. 배설물이 있으면 자동 청소를 시작한다.
// 9. 배설물이 없으면 현재 센서 상태에 맞는 대기 상태로 복귀한다.
// 10. 분석 오류가 나면 모델만 우선 재로딩해 부분 복구를 시도한다.
// 11. 청소 중 강아지가 다시 올라오면 청소를 일시정지한다.
// 12. 강아지가 다시 내려가면 남은 청소를 이어서 재개한다.
// 13. 수동 청소 요청이 오면 별도 승인 없이 바로 청소를 시작한다.

// 정적 파일과 기본 미들웨어 등록
app.use('/tfjs_model', express.static(path.join(__dirname, 'tfjs_model')));
app.use(express.static(path.join(__dirname), {
  setHeaders: res => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));
app.use(cors());
app.use(bodyParser.json());

// 런타임 상태값과 세션 정보 보관
let sensorData = {
  temperature: 0,
  humidity: 0,
  access: false,
  rawAccess: false,
  poop: 'n',
  time: '',
  state: STATES.IDLE
};
let systemState = STATES.IDLE;
let model = null;
let modelLoadingPromise = null;
let captureInProgress = false;
let resetTimer = null;
let stableAccessState = false;
let rawAccessState = false;
let accessTransitionTimer = null;
let accessEnteredAt = 0;
let failureCounts = {
  capture: 0,
  model: 0,
  cleaning: 0
};

let cleaningSession = {
  type: '',
  startedAt: 0,
  elapsedBeforePause: 0,
  timeoutIds: []
};

// 웹캠 캡처 옵션 설정
const Webcam = NodeWebcam.create({
  width: 320,
  height: 240,
  quality: 80,
  output: 'jpeg',
  device: '/dev/video0',
  callbackReturn: 'location',
  verbose: false
});

// 공통 상태/유틸 함수
function setSystemState(nextState, reason = '') {
  if (systemState !== nextState) {
    console.log(`[STATE] ${systemState} -> ${nextState}${reason ? ` (${reason})` : ''}`);
  } else if (reason) {
    console.log(`[STATE] ${nextState} (${reason})`);
  }

  systemState = nextState;
  sensorData.state = nextState;
  broadcast('stateUpdate', { state: nextState, reason, time: new Date().toISOString() });
}

// WebSocket 전송
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function clearCleaningTimers() {
  cleaningSession.timeoutIds.forEach(clearTimeout);
  cleaningSession.timeoutIds = [];
}

function resetCleaningSession() {
  clearCleaningTimers();
  cleaningSession = {
    type: '',
    startedAt: 0,
    elapsedBeforePause: 0,
    timeoutIds: []
  };
}

function getCleaningElapsedMs() {
  if (!cleaningSession.startedAt) {
    return cleaningSession.elapsedBeforePause;
  }

  return cleaningSession.elapsedBeforePause + (Date.now() - cleaningSession.startedAt);
}

function getRestingState() {
  return stableAccessState ? STATES.OCCUPIED : STATES.IDLE;
}

function syncStateWithAccess(reason) {
  setSystemState(getRestingState(), reason);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resetFailureCount(kind) {
  failureCounts[kind] = 0;
}

function registerFailure(kind, context, error) {
  failureCounts[kind] += 1;
  console.error(`[ERROR] ${context}:`, error.message, `(누적 ${failureCounts[kind]}회)`);
  return failureCounts[kind];
}

function resetRuntimeState() {
  clearCleaningTimers();
  if (accessTransitionTimer) {
    clearTimeout(accessTransitionTimer);
    accessTransitionTimer = null;
  }
  captureInProgress = false;
  sensorData.poop = 'n';
  try {
    servo.servoWrite(1500);
  } catch (err) {
    console.error('[SERVO] 시스템 리셋 중 중립 위치 복귀 실패:', err.message);
  }
  resetCleaningSession();
  rawAccessState = stableAccessState;
  sensorData.rawAccess = rawAccessState;
  failureCounts = {
    capture: 0,
    model: 0,
    cleaning: 0
  };
  syncStateWithAccess('시스템 리셋 완료');
}

// 오류 복구와 모델 재로딩 처리
async function loadModel(forceReload = false) {
  if (model && !forceReload) return model;
  if (modelLoadingPromise && !forceReload) return modelLoadingPromise;

  modelLoadingPromise = (async () => {
    try {
      model = null;
      model = await tf.loadLayersModel(MODEL_URL);
      console.log('모델 로딩 완료:', MODEL_URL);
      return model;
    } catch (err) {
      console.error('모델 로딩 실패:', err.message);
      throw err;
    } finally {
      modelLoadingPromise = null;
    }
  })();

  return modelLoadingPromise;
}

function scheduleFatalRecovery(context, error) {
  console.error(`[FATAL] ${context}:`, error.message);
  clearCleaningTimers();
  captureInProgress = false;

  try {
    servo.servoWrite(1500);
  } catch (servoError) {
    console.error('[SERVO] 치명적 복구 중 중립 위치 복귀 실패:', servoError.message);
  }

  setSystemState(STATES.ERROR, `${context} 오류`);

  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(async () => {
    console.log(`[RECOVERY] ${ERROR_RECOVERY_MS}ms 후 시스템 재초기화`);
    resetTimer = null;
    resetRuntimeState();

    try {
      await loadModel(true);
      syncStateWithAccess('오류 복구 완료');
    } catch (reloadError) {
      scheduleFatalRecovery('모델 재로딩', reloadError);
    }
  }, ERROR_RECOVERY_MS);
}

function handleCleaningError(context, error) {
  const failureCount = registerFailure('cleaning', context, error);
  resetCleaningSession();

  try {
    servo.servoWrite(1500);
  } catch (servoError) {
    console.error('[SERVO] 청소 오류 처리 중 중립 위치 복귀 실패:', servoError.message);
  }

  if (failureCount >= MAX_CLEANING_FAILURES_BEFORE_FATAL) {
    scheduleFatalRecovery(context, error);
    return false;
  }

  syncStateWithAccess(`${context} 후 청소 세션 정리`);
  return false;
}

function safeServoWrite(pulse, context) {
  try {
    servo.servoWrite(pulse);
    return true;
  } catch (error) {
    return handleCleaningError(context, error);
  }
}

async function recoverModel(context, error) {
  const failureCount = registerFailure('model', context, error);
  model = null;

  if (failureCount >= MAX_MODEL_FAILURES_BEFORE_FATAL) {
    scheduleFatalRecovery(context, error);
    return false;
  }

  try {
    console.log(`[RECOVERY] 모델 재로딩 대기 ${MODEL_RETRY_DELAY_MS}ms`);
    await wait(MODEL_RETRY_DELAY_MS);
    await loadModel(true);
    resetFailureCount('model');
    console.log('[RECOVERY] 모델 재로딩 성공');
    return true;
  } catch (reloadError) {
    return recoverModel('모델 재로딩', reloadError);
  }
}

// 사진 촬영과 재시도 처리
async function captureImage() {
  if (captureInProgress) {
    throw new Error('이미 사진 촬영이 진행 중입니다.');
  }

  captureInProgress = true;

  try {
    await fs.promises.unlink(TEMP_CAPTURE_PATH).catch(err => {
      if (err.code !== 'ENOENT') throw err;
    });

    console.log('사진 촬영 시도');
    const savedPath = await new Promise((resolve, reject) => {
      Webcam.capture(TEMP_CAPTURE_BASENAME, (err, data) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(data || TEMP_CAPTURE_PATH);
      });
    });

    const normalizedPath = savedPath.endsWith('.jpg') ? savedPath : TEMP_CAPTURE_PATH;
    console.log('사진 촬영 완료:', normalizedPath);
    broadcast('captureSuccess', { filename: path.basename(normalizedPath) });
    return normalizedPath;
  } finally {
    captureInProgress = false;
  }
}

async function captureImageWithRetry() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_CAPTURE_RETRIES + 1; attempt += 1) {
    try {
      const imagePath = await captureImage();
      resetFailureCount('capture');
      return imagePath;
    } catch (error) {
      lastError = error;
      console.error(`[CAPTURE] 촬영 실패 ${attempt}/${MAX_CAPTURE_RETRIES + 1}:`, error.message);

      if (attempt <= MAX_CAPTURE_RETRIES) {
        await wait(CAPTURE_RETRY_DELAY_MS);
      }
    }
  }

  const failureCount = registerFailure('capture', '사진 촬영 실패', lastError);
  if (failureCount >= MAX_CAPTURE_FAILURES_BEFORE_FATAL) {
    scheduleFatalRecovery('사진 촬영 실패', lastError);
  }

  return null;
}

// AI 예측으로 배설물 여부 판단
async function detectWaste(imagePath) {
  await loadModel();

  let imageTensor;
  let predictionTensor;

  try {
    const jpegData = await fs.promises.readFile(imagePath);
    const raw = jpeg.decode(jpegData, { useTArray: true });

    imageTensor = tf.tidy(() => tf.tensor3d(raw.data, [raw.height, raw.width, 4], 'int32')
      .slice([0, 0, 0], [-1, -1, 3])
      .resizeBilinear([64, 64])
      .toFloat()
      .div(255)
      .expandDims(0));

    predictionTensor = model.predict(imageTensor);
    const [poop, urine, none] = await predictionTensor.data();
    const wasteScore = poop + urine;
    const margin = wasteScore - none;
    const detectedWaste = wasteScore > 0.9 && margin > 0.2;

    sensorData.poop = detectedWaste ? 'y' : 'n';

    console.log(
      '예측결과 → poop:',
      poop.toFixed(3),
      'urine:',
      urine.toFixed(3),
      'none:',
      none.toFixed(3)
    );
    console.log('wasteScore:', wasteScore.toFixed(3), 'margin:', margin.toFixed(3), '→ 감지 결과:', detectedWaste ? '감지됨' : '미감지');

    return detectedWaste;
  } finally {
    if (predictionTensor && typeof predictionTensor.dispose === 'function') predictionTensor.dispose();
    if (imageTensor) imageTensor.dispose();
  }
}

// 청소 시퀀스 시작, 일시정지, 이어서 재개
function finishCleaning() {
  const completedType = cleaningSession.type || 'auto';
  resetCleaningSession();
  sensorData.poop = 'n';
  if (!safeServoWrite(1500, `${completedType} 청소 종료`)) {
    return;
  }
  resetFailureCount('cleaning');
  syncStateWithAccess(`${completedType} 청소 완료`);
}

function scheduleCleaning(type, elapsedMs = 0) {
  clearCleaningTimers();
  cleaningSession.type = type;
  cleaningSession.startedAt = Date.now();
  cleaningSession.elapsedBeforePause = elapsedMs;

  setSystemState(STATES.CLEANING, elapsedMs > 0 ? `${type} 청소 이어서 재개` : `${type} 청소 시작`);

  CLEANING_STEPS.forEach(step => {
    if (step.atMs < elapsedMs) return;

    const delay = Math.max(step.atMs - elapsedMs, 0);
    const timeoutId = setTimeout(() => {
      console.log(`servoWrite(${step.pulse})`);
      safeServoWrite(step.pulse, `${type} 청소 단계 ${step.atMs}ms`);
    }, delay);

    cleaningSession.timeoutIds.push(timeoutId);
  });

  const remainingMs = Math.max(CLEANING_TOTAL_MS - elapsedMs, 0);
  const finishTimeoutId = setTimeout(() => {
    finishCleaning();
  }, remainingMs);

  cleaningSession.timeoutIds.push(finishTimeoutId);
}

function startCleaning(type = 'auto') {
  if (systemState === STATES.CLEANING || systemState === STATES.PAUSED || systemState === STATES.ANALYZING || systemState === STATES.ERROR) {
    console.log(`[CLEANING] ${type} 청소 요청 무시 - 현재 상태: ${systemState}`);
    return;
  }

  scheduleCleaning(type, 0);
}

function pauseCleaning() {
  if (systemState !== STATES.CLEANING) return;

  const elapsedMs = Math.min(getCleaningElapsedMs(), CLEANING_TOTAL_MS);
  clearCleaningTimers();
  cleaningSession.elapsedBeforePause = elapsedMs;
  cleaningSession.startedAt = 0;
  if (!safeServoWrite(1500, '청소 일시정지')) {
    return;
  }

  console.log(`강아지 감지됨, 청소 일시정지 (진행 ${elapsedMs}ms)`);
  setSystemState(STATES.PAUSED, '강아지 재접근');
}

function resumeCleaningSequence() {
  if (systemState !== STATES.PAUSED) return;

  const elapsedMs = cleaningSession.elapsedBeforePause;
  if (elapsedMs >= CLEANING_TOTAL_MS) {
    finishCleaning();
    return;
  }

  console.log(`청소 재개 (이어진 시점 ${elapsedMs}ms)`);
  scheduleCleaning(cleaningSession.type || 'auto', elapsedMs);
}

// 강아지 이탈 시 분석 후 자동 청소 판단
async function analyzeAndMaybeClean() {
  if (systemState === STATES.ANALYZING || systemState === STATES.ERROR) return;

  setSystemState(STATES.ANALYZING, '배설물 분석 시작');

  // 6. 강아지가 내려간 뒤 최신 사진 한 장만 촬영하고, 실패하면 재시도한다.
  const imagePath = await captureImageWithRetry();
  if (!imagePath) {
    if (systemState !== STATES.ERROR) {
      syncStateWithAccess('캡처 실패로 분석 취소');
    }
    return;
  }

  try {
    // 7. 촬영한 이미지를 AI 모델로 분석해 배설물 유무만 판단한다.
    const detectedWaste = await detectWaste(imagePath);

    if (detectedWaste) {
      // 8. 배설물이 있으면 자동 청소를 시작한다.
      console.log('배설물 감지됨 → 자동 청소 시작');
      resetFailureCount('model');
      scheduleCleaning('auto', 0);
    } else {
      // 9. 배설물이 없으면 현재 센서 상태에 맞는 대기 상태로 돌아간다.
      console.log('배설물 없음');
      resetFailureCount('model');
      syncStateWithAccess('분석 완료');
    }
  } catch (err) {
    // 10. 분석 오류가 나면 모델만 재로딩해 먼저 부분 복구를 시도한다.
    const recovered = await recoverModel('배설물 분석', err);
    if (!recovered && systemState === STATES.ERROR) {
      return;
    }

    syncStateWithAccess('분석 실패 후 모델 복구');
  }
}

// 센서 원시값을 확정된 올라옴/내려옴 상태로 변환
function handleStableAccessState(isAccessed, sourceLabel) {
  sensorData.access = isAccessed;
  sensorData.rawAccess = rawAccessState;
  sensorData.time = new Date().toISOString();

  if (isAccessed) {
    // 4. 올라옴이 확정되면 감시 상태로 전환하고, 청소 중이면 일시정지 여부를 판단한다.
    accessEnteredAt = Date.now();
    console.log(`[${sourceLabel}] 접근 확정 (강아지 올라옴)`);
  } else {
    // 5. 내려옴이 확정되면 점유 시간을 기록하고, 필요하면 분석 단계로 넘긴다.
    const occupiedForMs = accessEnteredAt ? Date.now() - accessEnteredAt : 0;
    accessEnteredAt = 0;
    console.log(`[${sourceLabel}] 이탈 확정 (강아지 내려감, 점유 ${occupiedForMs}ms)`);
  }

  broadcast('sensorUpdate', sensorData);

  if (systemState === STATES.ERROR) {
    console.log(`[${sourceLabel}] 오류 복구 대기 중이라 센서 이벤트를 보류합니다.`);
    return;
  }

  if (isAccessed) {
    if (systemState === STATES.CLEANING) {
      const elapsedMs = getCleaningElapsedMs();
      if (elapsedMs < CLEANING_PAUSE_IGNORE_MS) {
        console.log(`[${sourceLabel}] 청소 시작 ${elapsedMs}ms 후 접근 감지 → 무시`);
      } else {
        // 11. 청소 중 강아지가 다시 올라오면 청소를 잠시 멈춘다.
        console.log(`[${sourceLabel}] 강아지 올라옴 → 청소 일시정지`);
        pauseCleaning();
      }
      return;
    }

    if (systemState === STATES.IDLE) {
      setSystemState(STATES.OCCUPIED, '감시 시작');
    }

    return;
  }

  if (systemState === STATES.PAUSED) {
    // 12. 다시 내려가면 남은 청소를 이어서 재개한다.
    console.log(`[${sourceLabel}] 청소 재개 조건 충족`);
    resumeCleaningSequence();
    return;
  }

  if (systemState === STATES.OCCUPIED) {
    // 5. 감시 중 내려감이 확정되면 사진 촬영과 분석을 시작한다.
    console.log(`[${sourceLabel}] 강아지 내려감 → 사진 캡처 및 분석 시작`);
    analyzeAndMaybeClean();
  }
}

function updateSensorState(isAccessed, sourceLabel) {
  // 2. IR 센서에서 들어온 원시값을 먼저 받고, 바로 상태를 바꾸지 않는다.
  rawAccessState = isAccessed;
  sensorData.rawAccess = isAccessed;

  const debounceMs = isAccessed ? ACCESS_RISE_DEBOUNCE_MS : ACCESS_FALL_DEBOUNCE_MS;
  console.log(
    `[${sourceLabel}] 센서 원시값: ${isAccessed ? '접근 감지' : '이탈 감지'} (${debounceMs}ms 확인 중)`
  );

  if (accessTransitionTimer) {
    clearTimeout(accessTransitionTimer);
    accessTransitionTimer = null;
  }

  if (stableAccessState === isAccessed) {
    return;
  }

  accessTransitionTimer = setTimeout(() => {
    // 3. 짧은 확인 시간이 지난 뒤에도 값이 같으면 올라옴/내려옴을 확정한다.
    accessTransitionTimer = null;

    if (rawAccessState !== isAccessed) {
      console.log(`[${sourceLabel}] 센서 상태가 다시 바뀌어 ${isAccessed ? '접근' : '이탈'} 확정을 취소합니다.`);
      return;
    }

    stableAccessState = isAccessed;
    handleStableAccessState(isAccessed, sourceLabel);
  }, debounceMs);
}

// 수동 청소 요청 처리
function handleManualClean() {
  // 13. 수동 청소 요청이 오면 별도 승인 없이 바로 청소를 시작한다.
  console.log('수동 청소 요청 수신');
  startCleaning('manual');
}

// 실제 IR 센서 이벤트 연결 지점
// 임시주석처리 ir센서 처리 안돼서, 테스트도해야해서
// IR.on('alert', (level, tick) => {
//   console.log('IR 센서 alert 감지됨 → level:', level, 'tick:', tick);
//   updateSensorState(level === 1, 'IR');
// });

// 테스트용 센서 시뮬레이션
let fakeAccess = false;
setInterval(() => {
  fakeAccess = !fakeAccess;
  updateSensorState(fakeAccess, 'TEST');
}, 5000);

// WebSocket 연결과 수동 청소 메시지 처리
wss.on('connection', ws => {
  connectedClients.add(ws);
  console.log('WebSocket 연결됨');
  ws.send(JSON.stringify({ type: 'sensorUpdate', data: sensorData }));

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'manualClean') handleManualClean();
    } catch (err) {
      console.error('WebSocket 데이터 파싱 에러:', err.message);
    }
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    console.log('WebSocket 연결 해제');
  });
});

// REST API 제공
app.get('/api/sensor', (req, res) => res.json(sensorData));
app.get('/capture', async (req, res) => {
  const imagePath = await captureImageWithRetry();

  if (!imagePath) {
    res.status(500).json({ message: '수동 캡처 실패', error: '촬영 재시도 후에도 실패했습니다.' });
    return;
  }

  res.json({ message: '수동 캡처 완료', filename: path.basename(imagePath) });
});

// 1. 서버를 시작한 뒤 AI 모델을 먼저 로딩해 자동 감지 준비를 끝낸다.
server.listen(PORT, async () => {
  console.log(`HTTP: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:8002`);

  try {
    await loadModel();
  } catch (err) {
    await recoverModel('초기 모델 로딩', err);
  }
});
