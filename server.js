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

// TensorFlow 백엔드 로더
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

// IR 센서 & 서보모터
const IR = new Gpio(23, { mode: Gpio.INPUT, pullUpDown: Gpio.PUD_DOWN, alert: true });
const servo = new Gpio(18, { mode: Gpio.OUTPUT });

// 서버 설정
const app = express();
const PORT = 8001;
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ port: 8002 });
const connectedClients = new Set();

// 정적 파일
app.use('/tfjs_model', express.static(path.join(__dirname, 'tfjs_model')));
app.use(express.static(path.join(__dirname), {
  setHeaders: (res, p) => { res.setHeader('Access-Control-Allow-Origin', '*'); }
}));
app.use(cors());
app.use(bodyParser.json());

// 상태 변수들
let sensorData = { temperature: 0, humidity: 0, access: false, poop: 'n', time: '' };
let isAutoCleaning = false;
let isCleaningPaused = false;
let resumeCleaning = false;
let detectedPoop = false;
let isMonitoring = false;
let currentCleaningType = '';
let cleaningTimeouts = [];
let model;
let cleaningStartedAt = 0;

// 경로/상수
const MODEL_DIR = path.join(__dirname, 'tfjs_model');
const INPUT_SIZE = 224;
const CLASSES = ['poop', 'urine', 'none'];

// 웹캠 설정
const Webcam = NodeWebcam.create({
  width: 640, height: 480, quality: 100,
  output: 'jpeg', device: '/dev/video0',
  callbackReturn: 'location', verbose: true
});

// WebSocket 브로드캐스트
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// 이미지 디코딩 → 텐서
function decodeToTensor(buf) {
  if (useNode) {
    let img = tf.node.decodeImage(buf, 3);
    img = tf.image.resizeBilinear(img, [INPUT_SIZE, INPUT_SIZE]).toFloat().div(255);
    img = img.sub(0.5).mul(2); // [-1,1]
    return img;
  } else {
    const { width, height, data } = jpeg.decode(buf, { useTArray: true });
    let img = tf.tensor3d(data, [height, width, 4], 'int32')
      .slice([0, 0, 0], [-1, -1, 3])
      .resizeBilinear([INPUT_SIZE, INPUT_SIZE])
      .toFloat()
      .div(255);
    img = img.sub(0.5).mul(2); // [-1,1]
    return img;
  }
}

// 모델 로딩
async function loadModel() {
  try {
    await loadTF();
    const modelPath = 'file://' + path.join(MODEL_DIR, 'model.json');
    model = await tf.loadLayersModel(modelPath);
    model.predict(tf.zeros([1, INPUT_SIZE, INPUT_SIZE, 3])).dispose(); // 예열
    console.log('모델 로딩 및 예열 완료');
  } catch (err) {
    console.error('모델 로딩 실패:', err.message);
  }
}
loadModel();

// 사진 촬영
function captureImage(callback) {
  try {
    fs.readdirSync(__dirname).forEach(file => {
      if (file.startsWith('photo_') && file.endsWith('.jpg')) fs.unlinkSync(path.join(__dirname, file));
    });
  } catch (e) {
    console.warn('이전 캡처 파일 정리 스킵:', e.message);
  }

  const filename = `photo_${Date.now()}`;
  Webcam.capture(filename, (err, data) => {
    if (err) return callback(err);
    broadcast('captureSuccess', { filename: path.basename(data) });
    callback(null, path.join(__dirname, `${filename}.jpg`));
  });
}

// AI 예측
async function detectImage(imagePath) {
  if (!model) {
    console.error('모델이 아직 로딩되지 않음');
    return;
  }
  try {
    const jpegData = fs.readFileSync(imagePath);
    const img = decodeToTensor(jpegData);
    const logits = model.predict(img.expandDims(0));
    const probs = await logits.data(); // [poop, urine, none]
    const poop = probs[0] ?? 0, urine = probs[1] ?? 0, none = probs[2] ?? 0;
    const margin = (poop + urine) - none;

    // 임계값은 현장에 맞게 조정
    detectedPoop = (poop + urine > 0.9 && margin > 0.2);

    console.log(
      '예측결과 →',
      'poop:', poop.toFixed(3),
      'urine:', urine.toFixed(3),
      'none:', none.toFixed(3),
      '| margin:', margin.toFixed(3),
      '| 감지:', detectedPoop ? 'Y' : 'N'
    );

    tf.dispose([img, logits]);
  } catch (e) {
    console.error('detectImage 에러:', e.message);
  }
}

// 청소 시퀀스
function runCleaningSequence(type = 'auto') {
  currentCleaningType = type;
  isAutoCleaning = true;
  isCleaningPaused = false;
  resumeCleaning = false;
  cleaningStartedAt = Date.now();

  cleaningTimeouts = [
    setTimeout(() => { console.log('servoWrite(500)'); servo.servoWrite(500); }, 0),
    setTimeout(() => { console.log('servoWrite(2500)'); servo.servoWrite(2500); }, 2000),
    setTimeout(() => { console.log('servoWrite(1500)'); servo.servoWrite(1500); }, 4000),
    setTimeout(() => {
      if (!isCleaningPaused) {
        console.log(`${type === 'auto' ? '자동' : '수동'} 청소 완료`);
        if (type === 'auto') detectedPoop = false;
        isAutoCleaning = false;
        currentCleaningType = '';
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
  if (!isAutoCleaning) runCleaningSequence('auto');
}

function handleManualClean() {
  if (!isAutoCleaning) runCleaningSequence('manual');
}

// IR 이벤트는 테스트 중이라 주석 유지
// IR.on('alert', ...);

// 테스트 시뮬레이션
let fakeAccess = false;
setInterval(() => {
  fakeAccess = !fakeAccess;
  const isAccessed = fakeAccess;
  sensorData.access = isAccessed;
  sensorData.time = new Date().toISOString();
  console.log(`[TEST] 센서 상태: ${isAccessed ? '접근됨 (강아지 올라옴)' : '이탈 (내려감)'}`);
  broadcast('sensorUpdate', sensorData);

  if (isAccessed) {
    if (isAutoCleaning && !isCleaningPaused) {
      const elapsed = Date.now() - cleaningStartedAt;
      if (elapsed < 4000) {
        console.log(`[TEST] 청소 시작 ${elapsed}ms 후 접근 감지 → 무시`);
      } else {
        console.log('[TEST] 강아지 올라옴 → 청소 일시정지');
        pauseCleaning();
      }
    }
    if (!isMonitoring) {
      isMonitoring = true;
      console.log('[TEST] 감시 시작됨');
    }
  } else {
    console.log('[TEST] 강아지 내려감 → 사진 캡처 시도');
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
    if (isCleaningPaused && resumeCleaning) {
      console.log('▶ [TEST] 청소 재개 조건 충족');
      resumeCleaningSequence();
    }
    isMonitoring = false;
  }
}, 5000);

// WebSocket 처리
wss.on('connection', ws => {
  connectedClients.add(ws);
  console.log('WebSocket 연결됨');

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'manualClean' && data.data.poop === 'y') handleManualClean();
    } catch (err) {
      console.error('WebSocket 데이터 파싱 에러:', err.message);
    }
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    console.log('WebSocket 연결 해제');
  });
});

// REST API
app.get('/api/sensor', (req, res) => res.json(sensorData));
app.get('/capture', (req, res) => {
  captureImage(async (err, imagePath) => {
    if (err) return res.status(500).send('캡처 실패');
    await detectImage(imagePath);
    res.json({ imagePath, detectedPoop });
  });
});

// 서버 시작
server.listen(PORT, () => {
  console.log(`HTTP: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:8002`);
});
