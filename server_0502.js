// 필수 모듈 불러오기
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const tf = require('@tensorflow/tfjs');
const Jimp = require('jimp');
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

// 학습모델 파일 서빙
app.use('/tfjs_model', express.static(path.join(__dirname, 'tfjs_model')));

// 정적 파일 서빙
app.use(express.static(path.join(__dirname)));
app.use(cors());
app.use(bodyParser.json());

// 센서 데이터 구조 변경 (pressure → access)
let sensorData = {
  temperature: 0,
  humidity: 0,
  access: false,
  poop: 'n',
  time: ''
};

let isAutoCleaning = false;
let detectedPoop = false;
let isMonitoring = false;
let model;

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
async function detectColor(imagePath) {
  if (!model) {
    console.error('❗ 모델이 아직 로딩되지 않음');
    return;
  }

  try {
    const img = await Jimp.read(imagePath);
    img.resize(64, 64);

    const pixels = [];
    img.scan(0, 0, img.bitmap.width, img.bitmap.height, (x, y, idx) => {
      pixels.push(img.bitmap.data[idx]);     // R
      pixels.push(img.bitmap.data[idx + 1]); // G
      pixels.push(img.bitmap.data[idx + 2]); // B
    });

    const tensor = tf.tensor4d(pixels, [1, 64, 64, 3]);
    const prediction = await model.predict(tensor).data();
    const maxIdx = prediction.indexOf(Math.max(...prediction));

    detectedPoop = (maxIdx === 0 || maxIdx === 1);
    console.log(detectedPoop ? '🧪 배변 감지 완료' : '❌ 배변 감지 실패');

  } catch (e) {
    console.error('❗ detectColor 에러:', e.message);
  }
}

// 자동 청소
function startAutoClean() {
  isAutoCleaning = true;
  servo.servoWrite(500);
  setTimeout(() => servo.servoWrite(2500), 2000);
  setTimeout(() => servo.servoWrite(1500), 4000);

  setTimeout(() => {
    console.log('✅ 자동 청소 완료');
    detectedPoop = false;
    isAutoCleaning = false;
  }, 10000);
}

// 수동 청소
function handleManualClean() {
  isAutoCleaning = true;
  servo.servoWrite(500);
  setTimeout(() => servo.servoWrite(2500), 2000);
  setTimeout(() => servo.servoWrite(1500), 4000);

  setTimeout(() => {
    console.log('✅ 수동 청소 완료');
    isAutoCleaning = false;
  }, 10000);
}

// IR 센서 감지 처리 (접근/이탈 감지)
IR.on('alert', (level, tick) => {
  const isAccessed = level === 1; //물체감지(강쥐접근)
  sensorData.access = isAccessed;
  sensorData.time = new Date().toISOString();
  broadcast('sensorUpdate', sensorData);

  if (!isAccessed && !isAutoCleaning && isMonitoring) {
    isMonitoring = false;
    console.log('⬇️ 이탈 감지, 캡처 시작');

    captureImage(async (err, imagePath) => {
      if (!err) {
        await detectColor(imagePath);
        if (detectedPoop) {
          console.log('💩 배변 감지됨');
          startAutoClean();
        } else {
          console.log('🧹 배변 없음');
        }
      }
    });
  }

  if (isAccessed && !isMonitoring) {
    isMonitoring = true;
    console.log('🧍 감시 시작');
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

// 수동 캡처 API
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
