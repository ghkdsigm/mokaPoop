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
  setHeaders: (res, path) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
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
let cleaningStartedAt = 0; // 청소 시작 시각

// 웹캠 설정
const Webcam = NodeWebcam.create({
  width: 640, height: 480, quality: 100, output: 'jpeg', device: '/dev/video0', callbackReturn: 'location', verbose: true
});

// 모델 로딩
async function loadModel() {
  try {
    model = await tf.loadLayersModel('http://localhost:8001/tfjs_model/model.json');
    console.log('모델 로딩 완료');
  } catch (err) {
    console.error('모델 로딩 실패:', err.message);
  }
}
loadModel();

// WebSocket 전송
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// 사진 촬영
function captureImage(callback) {
  console.log('사진 촬영 시도');
  fs.readdirSync(__dirname).forEach(file => {
    if (file.startsWith('photo_') && file.endsWith('.jpg')) fs.unlinkSync(path.join(__dirname, file));
  });
  const filename = `photo_${Date.now()}`;
  Webcam.capture(filename, (err, data) => {
    if (err) return callback(err);
    console.log('사진 촬영 완료:', data);
    broadcast('captureSuccess', { filename: path.basename(data) });
    callback(null, path.join(__dirname, `${filename}.jpg`));
  });
}

// AI 예측
async function detectImage(imagePath) {
  if (!model) return console.error('모델이 아직 로딩되지 않음');
  try {
    const jpegData = fs.readFileSync(imagePath);
    const raw = jpeg.decode(jpegData, { useTArray: true });
    const tensor = tf.tensor3d(raw.data, [raw.height, raw.width, 4], 'int32')
      .slice([0, 0, 0], [-1, -1, 3])
      .resizeBilinear([64, 64]) // 원래 64x64였으나, 모델에 맞춰 224x224로 변경 3단계로변경해서..
      //.resizeBilinear([224, 224])
      .toFloat().div(255).expandDims(0);
    const [poop, urine, none] = await model.predict(tensor).data();
    const margin = (poop + urine) - none;
    detectedPoop = (poop + urine > 0.9 && margin > 0.2);
    console.log('예측결과 → poop:', poop.toFixed(3), 'urine:', urine.toFixed(3), 'none:', none.toFixed(3));
    console.log('margin:', margin.toFixed(3), '→ 감지 결과:', detectedPoop ? '감지됨' : '미감지');
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

// IR 센서 감지 처리
// 임시주석처리 ir센서 처리 안돼서, 테스트도해야해서
// IR.on('alert', (level, tick) => {
//   console.log('IR 센서 alert 감지됨 → level:', level, 'tick:', tick);
//   const isAccessed = level === 1;
//   sensorData.access = isAccessed;
//   sensorData.time = new Date().toISOString();

//   console.log('현재 sensorData:', sensorData);

//   broadcast('sensorUpdate', sensorData);

  
//     // 배변ai테스트 지우면됩니다
//     // isMonitoring = false;
//     console.log('이탈 감지, 캡처 시작');

//     captureImage(async (err, imagePath) => {
//       if (!err) {
//         await detectImage(imagePath);
//         if (detectedPoop) {
//           console.log('배변 감지됨 → 자동 청소 시작');
//           startAutoClean();
//         } else {
//           console.log('배변 없음');
//         }
//       }
//     });
//     // 테스트ai테스트 지우면됩니다

//   // 강아지 올라옴 → 감지되면 청소 멈춤
//   if (isAccessed && isAutoCleaning && !isCleaningPaused) {
//     console.log('IR 감지 → 청소 일시정지');
//     pauseCleaning();
//   }

//   // 강아지 내려감 → 재개 조건되면 청소 재개
//   if (!isAccessed && isCleaningPaused && resumeCleaning) {
//     console.log('IR 미감지 → 청소 재개');
//     resumeCleaningSequence();
//   }

//   // 이탈 → 감시 중이면 AI 감지 시작
//   if (!isAccessed && !isAutoCleaning && isMonitoring) {
//     isMonitoring = false;
//     console.log('이탈 감지, 캡처 시작');

//     captureImage(async (err, imagePath) => {
//       if (!err) {
//         await detectImage(imagePath);
//         if (detectedPoop) {
//           console.log('배변 감지됨 → 자동 청소 시작');
//           startAutoClean();
//         } else {
//           console.log('배변 없음');
//         }
//       }
//     });
//   }

//   // 처음 올라올 때 감시 시작
//   if (isAccessed && !isMonitoring) {
//     isMonitoring = true;
//     console.log('감시 모드 시작됨 (강아지 올라옴)');
//   }
// });

 
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
  captureImage(() => res.send('수동 캡처 완료'));
});

// 서버 시작
server.listen(PORT, () => {
  console.log(`HTTP: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:8002`);
});
