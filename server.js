// server.js
// 필수 모듈 불러오기
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const jpeg = require('jpeg-js');
const NodeWebcam = require('node-webcam');
const { Gpio } = require('pigpio');

// ==============================
// 환경 및 설정
// ==============================
const PORT = 8001;
const WS_PORT = 8002;
const MODEL_DIR = path.join(__dirname, 'tfjs_model');
const INPUT_SIZE = 224;
const CLASSES = ['poop', 'urine', 'none'];

// 임계값은 현장 로그로 조정
const THRESH_SUM = 0.85;
const THRESH_MARGIN = 0.15;

// 캡처 및 추론 제어
const MIN_CAPTURE_INTERVAL = 3000; // ms
let lastCaptureTime = 0;
let isInferenceRunning = false;

// ==============================
// TensorFlow 백엔드 로더
// ==============================
let tf;
let useNode = false;
async function loadTF() {
  try {
    tf = require('@tensorflow/tfjs-node');
    useNode = true;
    console.log('[TF] backend: tfjs-node');
  } catch (e) {
    tf = require('@tensorflow/tfjs');
    require('@tensorflow/tfjs-backend-wasm');
    await tf.setBackend('wasm');
    await tf.ready();
    console.log('[TF] backend: tfjs + wasm');
  }
}

// ==============================
// 하드웨어 설정
// ==============================
const IR = new Gpio(23, { mode: Gpio.INPUT, pullUpDown: Gpio.PUD_DOWN, alert: true });
const servo = new Gpio(18, { mode: Gpio.OUTPUT });

// ==============================
// 서버 및 통신
// ==============================
const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ port: WS_PORT });
const connectedClients = new Set();

app.use('/tfjs_model', express.static(MODEL_DIR));
app.use(express.static(path.join(__dirname), {
  setHeaders: (res) => { res.setHeader('Access-Control-Allow-Origin', '*'); }
}));
app.use(cors());
app.use(bodyParser.json());

// 상태 변수
let sensorData = { temperature: 0, humidity: 0, access: false, poop: 'n', time: '' };
let isAutoCleaning = false;
let isCleaningPaused = false;
let resumeCleaning = false;
let detectedPoop = false;
let isMonitoring = false;
let currentCleaningType = '';
let cleaningTimeouts = [];
let cleaningStartedAt = 0;

// 성능 모니터링
let inferenceCount = 0;
let totalInferenceTime = 0;

// ==============================
// 웹캠 설정
// ==============================
const Webcam = NodeWebcam.create({
  width: 480, height: 360,
  quality: 85,
  output: 'jpeg',
  device: '/dev/video0',
  callbackReturn: 'location',
  verbose: false
});

// ==============================
// 유틸
// ==============================
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function cleanupMemory() {
  if (global.gc) global.gc();
  if (tf && tf.memory) {
    const m = tf.memory();
    console.log(`[MEM] Tensors=${m.numTensors}, Bytes=${m.numBytes}`);
  }
}

// ==============================
// 이미지 디코딩 → 텐서 (224, [-1,1])
// ==============================
function decodeToTensor(buf) {
  let img;
  try {
    if (useNode) {
      img = tf.node.decodeImage(buf, 3);
      img = tf.image.resizeBilinear(img, [INPUT_SIZE, INPUT_SIZE], false, false).toFloat().div(255);
    } else {
      const { width, height, data } = jpeg.decode(buf, { useTArray: true });
      img = tf.tensor3d(data, [height, width, 4], 'int32')
        .slice([0, 0, 0], [-1, -1, 3])
        .resizeBilinear([INPUT_SIZE, INPUT_SIZE])
        .toFloat()
        .div(255);
    }
    // 0~1 → [-1,1]
    return img.sub(0.5).mul(2);
  } catch (e) {
    console.error('이미지 디코딩 오류:', e.message);
    if (img) img.dispose();
    return null;
  }
}

// ==============================
// 모델 로딩 및 예열
// ==============================
let model;
async function loadModel() {
  try {
    await loadTF();
    const modelPath = 'file://' + path.join(MODEL_DIR, 'model.json');
    console.log('모델 로딩 중...');
    const t0 = Date.now();
    model = await tf.loadLayersModel(modelPath);
    console.log(`모델 로딩 완료: ${Date.now() - t0}ms`);

    console.log('모델 예열 중...');
    const warm = model.predict(tf.zeros([1, INPUT_SIZE, INPUT_SIZE, 3]));
    await warm.data();
    warm.dispose();
    console.log('모델 예열 완료');

    cleanupMemory();
  } catch (err) {
    console.error('모델 로딩 실패:', err.message);
  }
}

// ==============================
// 캡처
// ==============================
function captureImage(callback) {
  const now = Date.now();
  if (now - lastCaptureTime < MIN_CAPTURE_INTERVAL) {
    return callback(new Error('캡처 간격 제한'));
  }
  lastCaptureTime = now;

  try {
    fs.readdirSync(__dirname).forEach(file => {
      if (file.startsWith('photo_') && file.endsWith('.jpg')) {
        fs.unlinkSync(path.join(__dirname, file));
      }
    });
  } catch (e) {
    console.warn('이전 캡처 파일 정리 스킵:', e.message);
  }

  const filename = `photo_${Date.now()}`;
  const t0 = Date.now();
  Webcam.capture(filename, (err, data) => {
    if (err) return callback(err);
    console.log(`캡처 완료: ${Date.now() - t0}ms`);
    broadcast('captureSuccess', { filename: path.basename(data) });
    callback(null, path.join(__dirname, `${filename}.jpg`));
  });
}

// ==============================
// 추론
// ==============================
async function detectImage(imagePath) {
  if (!model || isInferenceRunning) {
    return;
  }
  isInferenceRunning = true;
  let img, logits;
  const t0 = Date.now();

  try {
    const buf = fs.readFileSync(imagePath);
    img = decodeToTensor(buf);
    if (!img) throw new Error('이미지 텐서 생성 실패');

    const input = img.expandDims(0);
    logits = model.predict(input);
    const probs = await logits.data();
    const poop = probs[0] ?? 0;
    const urine = probs[1] ?? 0;
    const none = probs[2] ?? 0;

    const sumPU = poop + urine;
    const margin = sumPU - none;
    detectedPoop = (sumPU > THRESH_SUM && margin > THRESH_MARGIN);

    const dt = Date.now() - t0;
    inferenceCount += 1;
    totalInferenceTime += dt;

    console.log(
      `[AI-${inferenceCount}] ${dt}ms (avg:${(totalInferenceTime / inferenceCount).toFixed(0)}ms)`,
      `poop:${poop.toFixed(3)} urine:${urine.toFixed(3)} none:${none.toFixed(3)} margin:${margin.toFixed(3)} -> ${detectedPoop ? 'Y' : 'N'}`
    );

    input.dispose();

    if (inferenceCount % 10 === 0) cleanupMemory();
  } catch (e) {
    console.error('detectImage 오류:', e.message);
  } finally {
    if (img) img.dispose();
    if (logits) logits.dispose();
    isInferenceRunning = false;
  }
}

// ==============================
// 청소 시퀀스
// ==============================
function runCleaningSequence(type = 'auto') {
  currentCleaningType = type;
  isAutoCleaning = true;
  isCleaningPaused = false;
  resumeCleaning = false;
  cleaningStartedAt = Date.now();

  console.log(`${type === 'auto' ? '자동' : '수동'} 청소 시작`);

  cleaningTimeouts = [
    setTimeout(() => { console.log('서보 시작 위치'); servo.servoWrite(500); }, 0),
    setTimeout(() => { console.log('서보 청소 동작'); servo.servoWrite(2500); }, 2000),
    setTimeout(() => { console.log('서보 원위치'); servo.servoWrite(1500); }, 4000),
    setTimeout(() => {
      if (!isCleaningPaused) {
        console.log(`${type === 'auto' ? '자동' : '수동'} 청소 완료`);
        if (type === 'auto') detectedPoop = false;
        isAutoCleaning = false;
        currentCleaningType = '';
        cleanupMemory();
      } else {
        console.log(`${type === 'auto' ? '자동' : '수동'} 청소 중단됨, 재개 대기중`);
        resumeCleaning = true;
      }
    }, 10000)
  ];
}

function pauseCleaning() {
  console.log('강아지 감지됨, 청소 일시정지');
  isCleaningPaused = true;
  cleaningTimeouts.forEach(clearTimeout);
  servo.servoWrite(1500);
}

function resumeCleaningSequence() {
  console.log('청소 재개');
  isCleaningPaused = false;
  resumeCleaning = false;
  runCleaningSequence(currentCleaningType);
}

function startAutoClean() {
  if (!isAutoCleaning && !isInferenceRunning) runCleaningSequence('auto');
}

function handleManualClean() {
  if (!isAutoCleaning) runCleaningSequence('manual');
}

// ==============================
// IR 센서 연결 예시 (현장 적용 시 주석 해제)
// ==============================
// IR.on('alert', (level) => {
//   const isAccessed = level === 1;
//   sensorData.access = isAccessed;
//   sensorData.time = new Date().toISOString();
//   broadcast('sensorUpdate', sensorData);

//   if (isAccessed) {
//     if (isAutoCleaning && !isCleaningPaused) {
//       const elapsed = Date.now() - cleaningStartedAt;
//       if (elapsed >= 4000) pauseCleaning();
//     }
//     if (!isMonitoring) {
//       isMonitoring = true;
//       console.log('감시 시작됨');
//     }
//   } else {
//     setTimeout(() => {
//       captureImage(async (err, imagePath) => {
//         if (!err) {
//           await detectImage(imagePath);
//           if (detectedPoop) startAutoClean();
//         } else {
//           console.error('캡처 실패:', err.message);
//         }
//       });
//     }, 500);

//     if (isCleaningPaused && resumeCleaning) {
//       setTimeout(() => {
//         if (resumeCleaning) resumeCleaningSequence();
//       }, 1000);
//     }
//     isMonitoring = false;
//   }
// });

// ==============================
// 테스트 시뮬레이션 타이머
// ==============================
let fakeAccess = false;
let testInterval = 8000;
const testTimer = setInterval(() => {
  fakeAccess = !fakeAccess;
  const isAccessed = fakeAccess;
  sensorData.access = isAccessed;
  sensorData.time = new Date().toISOString();
  console.log(`[TEST] 센서 상태: ${isAccessed ? '접근됨' : '이탈'}`);
  broadcast('sensorUpdate', sensorData);

  if (isAccessed) {
    if (isAutoCleaning && !isCleaningPaused) {
      const elapsed = Date.now() - cleaningStartedAt;
      if (elapsed >= 4000) pauseCleaning();
    }
    if (!isMonitoring) {
      isMonitoring = true;
      console.log('[TEST] 감시 시작됨');
    }
  } else {
    setTimeout(() => {
      captureImage(async (err, imagePath) => {
        if (!err) {
          await detectImage(imagePath);
          if (detectedPoop) {
            console.log('[TEST] 배변 감지됨 → 자동 청소 시작');
            startAutoClean();
          } else {
            console.log('[TEST] 배변 없음');
          }
        } else {
          console.error('캡처 실패:', err.message);
        }
      });
    }, 800);

    if (isCleaningPaused && resumeCleaning) {
      setTimeout(() => {
        if (resumeCleaning) {
          console.log('▶ [TEST] 청소 재개 조건 충족');
          resumeCleaningSequence();
        }
      }, 1500);
    }
    isMonitoring = false;
  }
}, testInterval);

// ==============================
// WebSocket
// ==============================
wss.on('connection', ws => {
  connectedClients.add(ws);
  console.log('WebSocket 연결됨');

  ws.send(JSON.stringify({
    type: 'performance',
    data: {
      inferenceCount,
      avgInferenceTime: inferenceCount > 0 ? totalInferenceTime / inferenceCount : 0,
      inputSize: INPUT_SIZE,
      memoryInfo: tf && tf.memory ? tf.memory() : null
    }
  }));

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'manualClean' && data.data.poop === 'y') handleManualClean();
      if (data.type === 'getPerformance') {
        ws.send(JSON.stringify({
          type: 'performance',
          data: {
            inferenceCount,
            avgInferenceTime: inferenceCount > 0 ? totalInferenceTime / inferenceCount : 0,
            inputSize: INPUT_SIZE,
            memoryInfo: tf && tf.memory ? tf.memory() : null
          }
        }));
      }
    } catch (err) {
      console.error('WebSocket 데이터 파싱 에러:', err.message);
    }
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    console.log('WebSocket 연결 해제');
  });
});

// ==============================
// REST API
// ==============================
app.get('/api/sensor', (req, res) => res.json(sensorData));

app.get('/capture', (req, res) => {
  if (isInferenceRunning) return res.status(429).json({ error: '추론 실행 중' });
  captureImage(async (err, imagePath) => {
    if (err) return res.status(500).send('캡처 실패: ' + err.message);
    await detectImage(imagePath);
    res.json({
      imagePath,
      detectedPoop,
      inferenceTime: inferenceCount > 0 ? totalInferenceTime / inferenceCount : 0
    });
  });
});

app.get('/api/performance', (req, res) => {
  res.json({
    inferenceCount,
    avgInferenceTime: inferenceCount > 0 ? totalInferenceTime / inferenceCount : 0,
    inputSize: INPUT_SIZE,
    memoryInfo: tf && tf.memory ? tf.memory() : null,
    isInferenceRunning
  });
});

app.post('/api/config', (req, res) => {
  const { testInterval: newInterval } = req.body;
  if (newInterval && newInterval >= 3000) {
    clearInterval(testTimer);
    console.log(`테스트 간격 변경: ${newInterval}ms`);
    // 필요 시 여기서 재설정 로직 추가
    return res.json({ message: `테스트 간격 ${newInterval}ms로 변경됨 (재시작 필요)` });
  }
  res.status(400).json({ error: '잘못된 설정값' });
});

// ==============================
// 종료 처리
// ==============================
process.on('SIGINT', () => {
  console.log('시스템 종료 중...');
  cleaningTimeouts.forEach(clearTimeout);
  clearInterval(testTimer);
  try {
    servo.servoWrite(1500);
    IR.removeAllListeners();
  } catch (e) {
    console.error('GPIO 정리 에러:', e.message);
  }
  try {
    if (tf && model) model.dispose();
  } catch (e) {}
  process.exit(0);
});

// ==============================
// 시작
// ==============================
loadModel();
server.listen(PORT, () => {
  console.log(`HTTP: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${WS_PORT}`);
  console.log(`입력 크기: ${INPUT_SIZE}x${INPUT_SIZE}, 임계값: sum>${THRESH_SUM}, margin>${THRESH_MARGIN}`);
});
