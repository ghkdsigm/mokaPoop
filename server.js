// 필요한 모듈 불러오기
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const cors = require('cors');
const tf = require('@tensorflow/tfjs'); // tfjs-node -> tfjs로 변경
const fs = require('fs');
const Jimp = require('jimp'); // 이미지 처리용
const NodeWebcam = require('node-webcam');
const Gpio = require('pigpio').Gpio;

// 서보모터 설정
const servo = new Gpio(18, { mode: Gpio.OUTPUT });

const app = express();
const PORT = 8001;

app.use(express.static(path.join(__dirname)));
app.use(cors());
app.use(bodyParser.json());

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ port: 8002 });
let connectedClients = new Set();

let sensorData = {
  temperature: 0,
  humidity: 0,
  pressure: 0,
  poop: 'n',
  time: ''
};
let isAutoCleaning = false;
let detectedPoop = false;
let isMonitoring = false;
let model;

// 모델 로드
async function loadModel() {
  model = await tf.loadLayersModel('file://tfjs_model/model.json');
  console.log('✅ AI 모델 로드 완료');
}
loadModel();

// 웹캠 설정
const webcamOpts = {
  width: 640,
  height: 480,
  quality: 100,
  output: 'jpeg',
  device: '/dev/video0',
  callbackReturn: 'location',
  verbose: true
};
const Webcam = NodeWebcam.create(webcamOpts);

function captureImage() {
  console.log('▶ captureImage() 호출됨');
  Webcam.capture('test', (err, data) => {
    if (err) {
      console.error('❌ 웹캠 캡처 에러:', err.message);
      broadcastWS('captureError', { message: err.message });
      return;
    }
    console.log('✅ 사진 캡처 완료:', data);
    broadcastWS('captureSuccess', { filename: path.basename(data) });
  });
}

function broadcastWS(type, payload) {
  const msg = JSON.stringify({ type, data: payload });
  connectedClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function generateRandomValue(min = 20, max = 25, outlierChance = 0.25, outlierMin = 50, outlierMax = 70) {
  const r = Math.random();
  if (r < outlierChance) {
    return parseFloat((outlierMin + Math.random() * (outlierMax - outlierMin)).toFixed(2));
  }
  return parseFloat((min + Math.random() * (max - min)).toFixed(2));
}

function generateSensorData() {
  sensorData = {
    temperature: generateRandomValue(),
    humidity: generateRandomValue(),
    pressure: generateRandomValue(20, 80),
    poop: detectedPoop ? 'y' : 'n',
    time: new Date().toISOString()
  };
  console.log('🔄 sensorData:', sensorData);
  broadcastWS('sensorUpdate', sensorData);
  if (sensorData.pressure >= 50 && !isAutoCleaning) {
    startMonitoring();
  }
}

function startMonitoring() {
  if (isMonitoring) return;
  isMonitoring = true;
  console.log('🧍 모니터링 시작');

  const interval = setInterval(() => {
    console.log('⏱ 현재 압력:', sensorData.pressure);
    if (sensorData.pressure < 40) {
      console.log('⬇️ 이탈 감지 → 촬영');
      clearInterval(interval);
      isMonitoring = false;
      captureImage();
      setTimeout(async () => {
        await detectColor();
        if (detectedPoop) {
          console.log('💩 배변 감지 → 자동 청소');
          startAutoClean();
        } else {
          console.log('🧹 배변 없음');
        }
      }, 2500);
    }
  }, 3000);
}

async function detectColor() {
  if (!model) return;
  try {
    const image = await Jimp.read(path.join(__dirname, 'test.jpg'));
    image.resize(64, 64);
    const pixels = [];
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
      pixels.push(image.bitmap.data[idx]);     // R
      pixels.push(image.bitmap.data[idx + 1]); // G
      pixels.push(image.bitmap.data[idx + 2]); // B
    });
    const tensor = tf.tensor4d(pixels, [1, 64, 64, 3]);
    const pred = await model.predict(tensor).data();
    const idx = pred.indexOf(Math.max(...pred));
    detectedPoop = idx === 0 || idx === 1;
    console.log(detectedPoop ? '🧪 AI 감지 됨' : '❌ AI 감지 안됨');
  } catch (e) {
    console.error('❗ AI 분석 오류:', e.message);
  }
}

function startAutoClean() {
  isAutoCleaning = true;
  servo.servoWrite(500);
  setTimeout(() => servo.servoWrite(2500), 2000);
  setTimeout(() => servo.servoWrite(1500), 4000);
  setTimeout(() => {
    console.log('✅ 청소 완료');
    detectedPoop = false;
    isAutoCleaning = false;
  }, 10000);
}

function handleManualClean(ws) {
  console.log('🖐️ 수동 청소 요청');
  isAutoCleaning = true;
  servo.servoWrite(500);
  setTimeout(() => servo.servoWrite(2500), 2000);
  setTimeout(() => servo.servoWrite(1500), 4000);
  setTimeout(() => {
    console.log('✅ 수동 청소 완료');
    isAutoCleaning = false;
  }, 10000);
}

wss.on('connection', ws => {
  connectedClients.add(ws);
  console.log('WebSocket 연결됨');

  const sensorInterval = setInterval(() => {
    if (!isAutoCleaning) generateSensorData();
  }, 5000);

  ws.on('message', msg => {
    try {
      const d = JSON.parse(msg);
      if (d.type === 'manualClean' && d.data.poop === 'y') {
        handleManualClean(ws);
      }
    } catch {}
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    clearInterval(sensorInterval);
    console.log('WebSocket 연결 종료');
  });
});

app.get('/api/sensor', (req, res) => {
  res.json(sensorData);
});

app.get('/capture', (req, res) => {
  captureImage();
  res.send('captureImage() 호출 완료');
});

server.listen(PORT, () => {
  console.log(`HTTP: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:8002`);
});