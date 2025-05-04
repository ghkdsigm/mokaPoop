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

// IR적외선 센서 세팅
const IR = new Gpio(23, {
  mode: Gpio.INPUT,
  pullUpDown: Gpio.PUD_DOWN,
  alert: true
});

// 서보모터 세팅 (GPIO 18)
const servo = new Gpio(18, { mode: Gpio.OUTPUT });

// 기본 세팅
const app = express();
const PORT = 8001;
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ port: 8002 });
const connectedClients = new Set();

// 정적 파일 서빙
app.use('/tfjs_model', express.static(path.join(__dirname, 'tfjs_model')));
app.use(express.static(path.join(__dirname)));
app.use(cors());
app.use(bodyParser.json());

// 센서 데이터 구조
let sensorData = {
  temperature: 0,
  humidity: 0,
  access: false,
  poop: 'n',
  time: ''
};

let isAutoCleaning = false;
let isCleaningPaused = false;
let resumeCleaning = false;
let detectedPoop = false;
let isMonitoring = false;
let model;
let currentCleaningType = ''; // 'auto' or 'manual'
let cleaningTimeouts = [];

// NodeWebcam 설정
const Webcam = NodeWebcam.create({
  width: 640,
  height: 480,
  quality: 100,
  output: 'jpeg',
  device: '/dev/video0',
  callbackReturn: 'location',
  verbose: true
});

// 모델 로딩
async function loadModel() {
  try {
    model = await tf.loadLayersModel('http://localhost:8001/tfjs_model/model.json');
    console.log('✅ 모델 로딩 완료');
  } catch (err) {
    console.error('❗ 모델 로딩 실패:', err.message);
  }
}
loadModel();

// WebSocket 메시지 브로드캐스트
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// 사진 촬영
function captureImage(callback) {
  console.log('📸 사진 촬영 시도');

  const files = fs.readdirSync(__dirname);
  files.forEach(file => {
    if (file.startsWith('photo_') && file.endsWith('.jpg')) {
      try {
        fs.unlinkSync(path.join(__dirname, file));
        console.log('🗑️ 삭제 완료:', file);
      } catch (err) {
        console.error('❗ 파일 삭제 실패:', err.message);
      }
    }
  });

  const filename = `photo_${Date.now()}`;
  Webcam.capture(filename, (err, data) => {
    if (err) {
      console.error('❌ 웹캠 캡처 실패:', err.message);
      broadcast('captureError', { message: err.message });
      return callback(err);
    }
    console.log('✅ 사진 촬영 완료:', data);
    broadcast('captureSuccess', { filename: path.basename(data) });
    callback(null, path.join(__dirname, `${filename}.jpg`));
  });
}

// 이미지 AI 분석
async function detectImage(imagePath) {
  if (!model) {
    console.error('❗ 모델이 아직 로딩되지 않음');
    return;
  }

  try {
    const jpegData = fs.readFileSync(imagePath);
    const rawImageData = jpeg.decode(jpegData, { useTArray: true });

    const imageTensor = tf.tensor3d(rawImageData.data, [rawImageData.height, rawImageData.width, 4], 'int32')
      .slice([0, 0, 0], [-1, -1, 3])        // RGBA → RGB
      .resizeBilinear([64, 64])            // ✅ 모델 입력 크기와 일치
      .toFloat()
      .div(255.0)
      .expandDims(0);                      // [1, 64, 64, 3]

    const prediction = await model.predict(imageTensor).data();
    const [poopProb, urineProb, noneProb] = prediction;
    const maxProb = Math.max(...prediction);
    const maxIdx = prediction.indexOf(maxProb);

    detectedPoop = (maxProb > 0.9 && maxIdx !== 2);
    console.log(
      detectedPoop
        ? `🧪 확신있는 배변 감지 (poop:${poopProb.toFixed(2)} / urine:${urineProb.toFixed(2)})`
        : '❌ 배변 감지 실패'
    );
  } catch (e) {
    console.error('❗ detectImage 에러:', e.message);
  }
}

// 청소 시퀀스
function runCleaningSequence(type = 'auto') {
  currentCleaningType = type;
  isAutoCleaning = true;
  isCleaningPaused = false;
  resumeCleaning = false;

  cleaningTimeouts = [
    setTimeout(() => servo.servoWrite(500), 0),
    setTimeout(() => servo.servoWrite(2500), 2000),
    setTimeout(() => servo.servoWrite(1500), 4000),
    setTimeout(() => {
      if (!isCleaningPaused) {
        console.log(`✅ ${type === 'auto' ? '자동' : '수동'} 청소 완료`);
        if (type === 'auto') detectedPoop = false;
        isAutoCleaning = false;
        currentCleaningType = '';
      } else {
        console.log(`🕒 ${type === 'auto' ? '자동' : '수동'} 청소 중단됨, 재개 대기중`);
        resumeCleaning = true;
      }
    }, 10000)
  ];
}

// 청소 일시정지
function pauseCleaning() {
  console.log('⏸️ 강아지 감지됨, 청소 일시정지');
  isCleaningPaused = true;
  cleaningTimeouts.forEach(clearTimeout);
  servo.servoWrite(1500); // 정지
}

// 청소 재개
function resumeCleaningSequence() {
  console.log('▶️ 청소 재개');
  isCleaningPaused = false;
  resumeCleaning = false;
  runCleaningSequence(currentCleaningType);
}

// 자동 청소
function startAutoClean() {
  if (isAutoCleaning) return;
  runCleaningSequence('auto');
}

// 수동 청소
function handleManualClean() {
  if (isAutoCleaning) return;
  runCleaningSequence('manual');
}

// IR 센서 감지 처리
IR.on('alert', (level, tick) => {
  console.log('📡 IR 센서 alert 감지됨 → level:', level, 'tick:', tick);
  const isAccessed = level === 1;
  sensorData.access = isAccessed;
  sensorData.time = new Date().toISOString();

  console.log('📝 현재 sensorData:', sensorData);

  broadcast('sensorUpdate', sensorData);

  // 강아지 올라옴 → 감지되면 청소 멈춤
  if (isAccessed && isAutoCleaning && !isCleaningPaused) {
    console.log('⛔ IR 감지 → 청소 일시정지');
    pauseCleaning();
  }

  // 강아지 내려감 → 재개 조건되면 청소 재개
  if (!isAccessed && isCleaningPaused && resumeCleaning) {
    console.log('▶ IR 미감지 → 청소 재개');
    resumeCleaningSequence();
  }

  // 이탈 → 감시 중이면 AI 감지 시작
  if (!isAccessed && !isAutoCleaning && isMonitoring) {
    isMonitoring = false;
    console.log('⬇️ 이탈 감지, 캡처 시작');

    captureImage(async (err, imagePath) => {
      if (!err) {
        await detectImage(imagePath);
        if (detectedPoop) {
          console.log('💩 배변 감지됨 → 자동 청소 시작');
          startAutoClean();
        } else {
          console.log('🧹 배변 없음');
        }
      }
    });
  }

  // 처음 올라올 때 감시 시작
  if (isAccessed && !isMonitoring) {
    isMonitoring = true;
    console.log('👀 감시 모드 시작됨 (강아지 올라옴)');
  }
});

// WebSocket 연결
wss.on('connection', ws => {
  connectedClients.add(ws);
  console.log('WebSocket 연결됨');

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'manualClean' && data.data.poop === 'y') {
        handleManualClean();
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

// API
app.get('/api/sensor', (req, res) => {
  res.json(sensorData);
});

app.get('/capture', (req, res) => {
  captureImage(() => {
    res.send('✅ 수동 캡처 완료');
  });
});

// 서버 시작
server.listen(PORT, () => {
  console.log(`HTTP: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:8002`);
});
