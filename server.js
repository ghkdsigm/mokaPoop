// server.js
// 필수 모듈 불러오기
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const jpeg = require('jpeg-js');

// 선택 모듈
let NodeWebcam = null;
try { NodeWebcam = require('node-webcam'); } catch (e) { /* optional */ }

let pigpioAvailable = true;
let Gpio = null;
try { ({ Gpio } = require('pigpio')); } catch (e) { pigpioAvailable = false; }

// ==============================
// 환경 및 설정
// ==============================
const PORT = Number(process.env.PORT || 8001);
const WS_PORT = Number(process.env.WS_PORT || 8002);
const INPUT_SIZE = Number(process.env.INPUT_SIZE || 224);
const CLASSES = ['poop', 'urine', 'none'];

// 임계값은 현장 로그로 조정
const THRESH_SUM = Number(process.env.THRESH_SUM || 0.85);
const THRESH_MARGIN = Number(process.env.THRESH_MARGIN || 0.15);

// 캡처 및 추론 제어
const MIN_CAPTURE_INTERVAL = Number(process.env.MIN_CAPTURE_INTERVAL || 3000);
let lastCaptureTime = 0;
let isInferenceRunning = false;

// 모델 폴더 탐색
function resolveModelDir() {
  const cands = [
    process.env.MODEL_DIR && path.resolve(process.env.MODEL_DIR),
    path.resolve(__dirname, 'tfjs_model'),
    path.resolve(__dirname, 'export', 'tfjs_model'),
  ].filter(Boolean);
  for (const d of cands) {
    if (fs.existsSync(path.join(d, 'model.json'))) return d;
  }
  return null;
}
const MODEL_DIR = resolveModelDir();
if (!MODEL_DIR) {
  console.error('[FATAL] model.json을 찾을 수 없습니다. MODEL_DIR을 환경변수로 지정하거나 tfjs_model 폴더를 확인하세요.');
  process.exit(1);
}
console.log('[INFO] MODEL_DIR =', MODEL_DIR);

// ==============================
// TensorFlow 백엔드 로더
// ==============================
let tf;
let backend = 'unknown';
async function loadTF() {
  try {
    tf = require('@tensorflow/tfjs-node');
    backend = 'tfjs-node';
    console.log('[TF] backend: tfjs-node');
  } catch (e) {
    console.warn('[TF] tfjs-node 로드 실패. wasm 백엔드로 폴백 시도:', e.message);
    tf = require('@tensorflow/tfjs');
    require('@tensorflow/tfjs-backend-wasm');
    await tf.setBackend('wasm');
    await tf.ready();
    backend = 'wasm';
    console.log('[TF] backend: tfjs + wasm');
  }
}

// ==============================
// 하드웨어 설정
// ==============================
const isLinux = os.platform() === 'linux';
const gpioEnabled = isLinux && pigpioAvailable;

const IR = gpioEnabled ? new Gpio(23, { mode: Gpio.INPUT, pullUpDown: Gpio.PUD_DOWN, alert: true }) : null;
const servo = gpioEnabled ? new Gpio(18, { mode: Gpio.OUTPUT }) : null;

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

// 마지막 캡처 파일 경로
let lastPhotoPath = null;

// ==============================
// 캡처 백엔드 탐색
// ==============================
const capCfg = {
  backend: 'unknown',
  device: process.env.CAM_DEVICE || '/dev/video0', // fswebcam 등 V4L2 계열에서 사용
  width: Number(process.env.CAM_WIDTH || 640),
  height: Number(process.env.CAM_HEIGHT || 480),
  quality: Number(process.env.CAM_QUALITY || 85),
  rpiIndex: process.env.CAM_INDEX ? Number(process.env.CAM_INDEX) : null // rpicam 계열에서 카메라 인덱스 선택
};

function checkBinary(bin) {
  return new Promise((resolve) => {
    execFile('which', [bin], (err, stdout) => {
      if (err) return resolve(false);
      resolve(Boolean(stdout && stdout.toString().trim()));
    });
  });
}

let webcam;
async function initCapture() {
  const hasRpiCam = await checkBinary('rpicam-jpeg');
  const hasLibcamera = await checkBinary('libcamera-jpeg');
  const hasFswebcam = await checkBinary('fswebcam');

  if (hasRpiCam) {
    capCfg.backend = 'rpicam';
    console.log('[CAPTURE] rpicam-jpeg 사용');
    return;
  }
  if (hasLibcamera) {
    capCfg.backend = 'libcamera';
    console.log('[CAPTURE] libcamera-jpeg 사용');
    return;
  }
  if (hasFswebcam) {
    capCfg.backend = 'fswebcam';
    console.log('[CAPTURE] fswebcam 사용');
    return;
  }
  if (NodeWebcam) {
    capCfg.backend = 'node-webcam';
    webcam = NodeWebcam.create({
      width: capCfg.width,
      height: capCfg.height,
      quality: capCfg.quality,
      output: 'jpeg',
      device: capCfg.device,
      callbackReturn: 'location',
      verbose: false
    });
    console.log('[CAPTURE] node-webcam 사용');
    return;
  }
  console.warn('[CAPTURE] 사용 가능한 캡처 백엔드가 없습니다. 캡처 기능이 동작하지 않습니다.');
}

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
  try {
    return tf.tidy(() => {
      let img;
      if (backend === 'tfjs-node') {
        img = tf.node.decodeImage(buf, 3)
          .resizeBilinear([INPUT_SIZE, INPUT_SIZE], false, false)
          .toFloat()
          .div(255);
      } else {
        const { width, height, data } = jpeg.decode(buf, { useTArray: true });
        img = tf.tensor3d(data, [height, width, 4], 'int32')
          .slice([0, 0, 0], [-1, -1, 3])
          .resizeBilinear([INPUT_SIZE, INPUT_SIZE])
          .toFloat()
          .div(255);
      }
      return img.sub(0.5).mul(2);
    });
  } catch (e) {
    console.error('이미지 디코딩 오류:', e.message);
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

    // 백엔드별 모델 경로 결정
    const isNode = backend === 'tfjs-node';
    const modelUrl = isNode
      ? 'file://' + path.join(MODEL_DIR, 'model.json')
      : `http://127.0.0.1:${PORT}/tfjs_model/model.json`;

    console.log('모델 로딩 중...', modelUrl);
    const t0 = Date.now();
    model = await tf.loadLayersModel(modelUrl);
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
function captureWithRpiCam(filename, cb) {
  const args = [];
  if (capCfg.rpiIndex !== null && !Number.isNaN(capCfg.rpiIndex)) {
    args.push('--camera', String(capCfg.rpiIndex));
  }
  args.push('--width', String(capCfg.width));
  args.push('--height', String(capCfg.height));
  args.push('--quality', String(capCfg.quality));
  args.push('-t', '1000');
  args.push('-o', filename);
  execFile('rpicam-jpeg', args, (err) => cb(err, filename));
}

function captureWithLibcamera(filename, cb) {
  const args = [
    '-o', filename,
    '--width', String(capCfg.width),
    '--height', String(capCfg.height),
    '--quality', String(capCfg.quality),
    '--timeout', '1000'
  ];
  execFile('libcamera-jpeg', args, (err) => cb(err, filename));
}

function captureWithFswebcam(filename, cb) {
  const args = [
    '--no-banner',
    '-d', capCfg.device,
    '-r', `${capCfg.width}x${capCfg.height}`,
    '--jpeg', String(capCfg.quality),
    filename
  ];
  execFile('fswebcam', args, (err) => cb(err, filename));
}

function captureWithNodeWebcam(filename, cb) {
  if (!webcam) return cb(new Error('node-webcam 미초기화'));
  webcam.capture(path.basename(filename, '.jpg'), (err) => cb(err, filename));
}

function captureImage(callback) {
  const now = Date.now();
  if (now - lastCaptureTime < MIN_CAPTURE_INTERVAL) {
    return callback(new Error('캡처 간격 제한'));
  }
  lastCaptureTime = now;

  try {
    for (const file of fs.readdirSync(__dirname)) {
      if (file.startsWith('photo_') && file.endsWith('.jpg')) {
        fs.unlinkSync(path.join(__dirname, file));
      }
    }
  } catch (e) {
    console.warn('이전 캡처 파일 정리 스킵:', e.message);
  }

  const filename = path.join(__dirname, `photo_${Date.now()}.jpg`);
  const t0 = Date.now();

  const done = (err, file) => {
    if (err) return callback(err);
    console.log(`캡처 완료: ${Date.now() - t0}ms`);
    lastPhotoPath = file;
    broadcast('captureSuccess', { filename: path.basename(file) });
    callback(null, file);
  };

  if (capCfg.backend === 'rpicam') return captureWithRpiCam(filename, done);
  if (capCfg.backend === 'libcamera') return captureWithLibcamera(filename, done);
  if (capCfg.backend === 'fswebcam') return captureWithFswebcam(filename, done);
  if (capCfg.backend === 'node-webcam') return captureWithNodeWebcam(filename, done);

  return callback(new Error('사용 가능한 캡처 백엔드가 없습니다'));
}

// ==============================
// 추론
// ==============================
async function detectImage(imagePath) {
  if (!model || isInferenceRunning) return;

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
      `[AI-${inferenceCount}] ${dt}ms (avg:${(totalInferenceTime / Math.max(1, inferenceCount)).toFixed(0)}ms)`,
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
  if (!gpioEnabled) {
    console.log(`[DRYRUN] ${type} 청소 시퀀스 (GPIO 비활성)`);
    return;
  }

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
  if (!gpioEnabled) return;
  console.log('강아지 감지됨, 청소 일시정지');
  isCleaningPaused = true;
  cleaningTimeouts.forEach(clearTimeout);
  servo.servoWrite(1500);
}

function resumeCleaningSequence() {
  if (!gpioEnabled) return;
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
// 테스트 시뮬레이션 타이머
// ==============================
let fakeAccess = false;
let testInterval = Number(process.env.TEST_INTERVAL || 8000);
let testTimer;

function startTestTimer() {
  if (testTimer) clearInterval(testTimer);
  testTimer = setInterval(() => {
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
            console.log('재개 조건 충족');
            resumeCleaningSequence();
          }
        }, 1500);
      }
      isMonitoring = false;
    }
  }, testInterval);
}
startTestTimer();

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
      memoryInfo: tf && tf.memory ? tf.memory() : null,
      backend
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
            memoryInfo: tf && tf.memory ? tf.memory() : null,
            backend
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
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    backend,
    modelLoaded: Boolean(model),
    gpioEnabled,
    captureBackend: capCfg.backend,
  });
});

app.get('/api/sensor', (req, res) => res.json(sensorData));

app.get('/capture', (req, res) => {
  if (isInferenceRunning) return res.status(429).json({ error: '추론 실행 중' });
  captureImage(async (err, imagePath) => {
    if (err) return res.status(500).send('캡처 실패: ' + err.message);
    await detectImage(imagePath);
    res.json({
      imagePath: path.basename(imagePath),
      detectedPoop,
      inferenceTimeMs: inferenceCount > 0 ? Math.round(totalInferenceTime / inferenceCount) : 0
    });
  });
});

app.get('/api/performance', (req, res) => {
  res.json({
    inferenceCount,
    avgInferenceTime: inferenceCount > 0 ? totalInferenceTime / inferenceCount : 0,
    inputSize: INPUT_SIZE,
    memoryInfo: tf && tf.memory ? tf.memory() : null,
    isInferenceRunning,
    backend
  });
});

// 마지막 캡처 이미지 바이너리 서빙
app.get('/last-photo.jpg', (req, res) => {
  try {
    if (!lastPhotoPath || !fs.existsSync(lastPhotoPath)) {
      return res.status(404).send('no photo yet');
    }
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(lastPhotoPath).pipe(res);
  } catch (e) {
    res.status(500).send('failed to read last photo');
  }
});

// 간단 뷰어 페이지
app.get('/viewer', (req, res) => {
  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Last Capture Viewer</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 16px; background: #0b0b0b; color: #fafafa; }
  .wrap { max-width: 960px; margin: 0 auto; }
  .row { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
  button { padding: 10px 14px; font-size: 14px; border-radius: 10px; border: 0; background: #2b72ff; color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  img { width: 100%; height: auto; background: #111; border-radius: 12px; }
  .meta { font-size: 12px; color: #bbb; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="row">
      <button id="btn">캡처 실행</button>
      <span class="meta" id="meta">대기중</span>
    </div>
    <img id="img" src="/last-photo.jpg" alt="last-capture" />
  </div>

<script>
  const img = document.getElementById('img');
  const meta = document.getElementById('meta');
  const btn = document.getElementById('btn');

  function refreshImage() {
    const url = '/last-photo.jpg?v=' + Date.now();
    img.src = url;
    meta.textContent = new Date().toLocaleString() + ' 업데이트';
  }

  setInterval(refreshImage, 5000);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    meta.textContent = '캡처 중...';
    try {
      const r = await fetch('/capture');
      if (!r.ok) throw new Error('capture failed');
      await r.json();
      refreshImage();
      meta.textContent = '캡처 완료';
    } catch (e) {
      meta.textContent = '캡처 실패';
    } finally {
      setTimeout(() => { btn.disabled = false; }, 800);
    }
  });

  refreshImage();
</script>
</body>
</html>`;
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

app.post('/api/config', (req, res) => {
  const { testInterval: newInterval } = req.body;
  if (newInterval && newInterval >= 3000) {
    testInterval = Number(newInterval);
    startTestTimer();
    console.log(`테스트 간격 변경: ${newInterval}ms`);
    return res.json({ message: `테스트 간격 ${newInterval}ms로 변경됨` });
  }
  res.status(400).json({ error: '잘못된 설정값' });
});

// ==============================
// 종료 처리
// ==============================
process.on('SIGINT', () => {
  console.log('시스템 종료 중...');
  cleaningTimeouts.forEach(clearTimeout);
  if (testTimer) clearInterval(testTimer);
  try {
    if (gpioEnabled) {
      servo.servoWrite(1500);
      IR.removeAllListeners();
    }
  } catch (e) {
    console.error('GPIO 정리 에러:', e.message);
  }
  try {
    if (tf && model && model.dispose) model.dispose();
  } catch (e) {}
  process.exit(0);
});

// ==============================
// 시작
// ==============================
function getLocalIP() {
  const ifs = os.networkInterfaces();
  for (const k in ifs) {
    for (const i of ifs[k]) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

(async () => {
  await initCapture();
  server.listen(PORT, '0.0.0.0', async () => {
    const ip = getLocalIP();
    console.log(`HTTP:  http://${ip}:${PORT}`);
    console.log(`WebSocket: ws://${ip}:${WS_PORT}`);
    console.log(`뷰어:  http://${ip}:${PORT}/viewer`);
    console.log(`입력 크기: ${INPUT_SIZE}x${INPUT_SIZE}, 임계값: sum>${THRESH_SUM}, margin>${THRESH_MARGIN}`);
    console.log(`백엔드: ${backend}, 캡처: ${capCfg.backend}, GPIO: ${gpioEnabled ? '사용' : '비활성'}`);

    // 서버가 떠서 /tfjs_model 정적 파일을 제공할 수 있는 상태에서 모델 로딩
    await loadModel();
  });
})();
