const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const tf = require('@tensorflow/tfjs-node');
const { Gpio } = require('pigpio');
const { exec } = require('child_process');

// FSWebcam 설정
const NodeWebcam = require('node-webcam');
const FSWebcam = NodeWebcam.FSWebcam;

const webcamOptions = {
  width: 640,
  height: 480,
  quality: 100,
  output: 'jpeg',
  device: '/dev/video0',
  callbackReturn: 'location',
  verbose: true,
  'no-banner': '',
  skip: 5,
};
const cam = new FSWebcam(webcamOptions);

// 서보모터(PWM)
const servo = new Gpio(18, { mode: Gpio.OUTPUT }); // GPIO18

// Express & WebSocket 세팅
const app = express();
const PORT = 8001;
app.use(express.static(path.join(__dirname)));
app.use(cors());
app.use(bodyParser.json());

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

let connectedClients = new Set();
let sensorData = { temperature:0, humidity:0, pressure:0, poop:'n', time:'' };
let isAutoCleaning = false;
let detectedPoop = false;
let isMonitoring = false;
let model;

// AI 모델 로드
async function loadModel() {
  model = await tf.loadLayersModel('file://tfjs_model/model.json');
  console.log('✅ AI 모델 로드 완료');
}
loadModel();

// 사진 캡처 함수 (fswebcam)
function captureImage() {
  console.log('▶ FSWebcam.capture 호출');
  const filePath = path.join(__dirname, 'test.jpg');
  cam.capture('test', (err, data) => {
    if (err) {
      console.error('❌ 캡처 에러:', err);
      connectedClients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify({ type:'captureError', data:{ message: err.message } })));      
      return;
    }
    console.log('✅ 캡처 완료:', data);
    const filename = path.basename(data);
    connectedClients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify({ type:'captureSuccess', data:{ filename } })));    
  });
}

// 가상 센서 생성
function generateRandomValue(min=20,max=25,outlierChance=0.25,outlierMin=50,outlierMax=70) {
  const rand = Math.random();
  if (rand < outlierChance) return +(outlierMin + Math.random()*(outlierMax-outlierMin)).toFixed(2);
  return +(min + Math.random()*(max-min)).toFixed(2);
}

// 센서 데이터 업데이트
function generateSensorData() {
  sensorData = {
    temperature: generateRandomValue(),
    humidity:    generateRandomValue(),
    pressure:    generateRandomValue(20,80),
    poop:        detectedPoop ? 'y':'n',
    time:        new Date().toISOString(),
  };
  console.log('🔄 sensorData:', sensorData);
  broadcastSensorData(sensorData);

  // 테스트: pressure>=30 시 바로 캡처
  if (sensorData.pressure >= 30) {
    console.log('▶ 테스트 캡처 트리거'); captureImage();
  }
  // 모니터링
  if (sensorData.pressure >= 25 && !isAutoCleaning) startMonitoring();
}

// WebSocket data 방송
function broadcastSensorData(data) {
  connectedClients.forEach(c => c.readyState===WebSocket.OPEN && c.send(JSON.stringify({ type:'sensorUpdate', data })));  
}

// 모니터링 & 촬영
function startMonitoring() {
  if (isMonitoring) return;
  isMonitoring = true;
  console.log('🧍 모니터링 시작');

  const mi = setInterval(() => {
    console.log('⏱ check pressure=', sensorData.pressure);
    if (sensorData.pressure < 35) {
      console.log('⬇️ 이탈 감지 → 촬영');
      clearInterval(mi);
      isMonitoring = false;
      captureImage();
      setTimeout(async ()=>{
        await detectColor();
        if (detectedPoop) { console.log('💩 감지! 자동청소'); startAutoClean(); }
        else console.log('🧹 배변 없음');
      },2500);
    }
  },3000);
}

// AI 예측
async function detectColor() {
  if (!model) return console.log('⛔ 모델 미로드');
  try {
    const buf = fs.readFileSync(path.join(__dirname,'test.jpg'));
    const tensor = tf.node.decodeImage(buf).resizeNearestNeighbor([64,64]).toFloat().expandDims();
    const pred = await model.predict(tensor).data();
    const idx = pred.indexOf(Math.max(...pred));
    detectedPoop = idx<2;
    console.log(idx===0?'💩 똥':'💧 오줌');
  } catch(e) { console.error('❗ 예측 에러:', e); }
}

// 자동 청소
function startAutoClean() {
  isAutoCleaning = true;
  servo.servoWrite(500);
  setTimeout(()=>servo.servoWrite(2500),2000);
  setTimeout(()=>servo.servoWrite(1500),4000);
  setTimeout(()=>{ console.log('✅ 청소 완료'); detectedPoop=false; isAutoCleaning=false; },10000);
}

// 수동 청소
function handleManualClean(ws) {
  console.log('🖐️ 수동청소 요청');
  isAutoCleaning=true;
  captureImage();
  ws.send(JSON.stringify({ type:'manualClean', data:{ status:'started' } }));
}

// WebSocket 연결
wss.on('connection', ws=>{
  connectedClients.add(ws);
  console.log('WebSocket 연결');
  const si = setInterval(()=>!isAutoCleaning&&generateSensorData(),5000);
  ws.on('message', msg=>{
    const d=JSON.parse(msg);
    if (d.type==='manualClean'&&d.data.poop==='y') handleManualClean(ws);
  });
  ws.on('close', ()=>{ connectedClients.delete(ws); clearInterval(si); console.log('연결 종료'); });
});

// HTTP 캡처 테스트 엔드포인트
app.get('/capture', (req,res)=>{ captureImage(); res.send('capture called'); });
app.get('/api/sensor',(req,res)=>res.json(sensorData));

// 서버 시작
server.listen(PORT,()=>console.log(`Server http://localhost:${PORT}, ws://localhost:${PORT}`));
