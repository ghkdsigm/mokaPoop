const express = require('express');
const path    = require('path');   
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const cors = require('cors');

// AI
const tf = require('@tensorflow/tfjs-node');
const fs = require('fs');

// 웹캠
const NodeWebcam = require('node-webcam');

// 서보모터
const Gpio = require('pigpio').Gpio;
const servo = new Gpio(18, { mode: Gpio.OUTPUT }); // GPIO 18번

const app = express();
const PORT = 8001;

app.use(express.static(path.join(__dirname)));

// Body-parser 설정
app.use(cors());
app.use(bodyParser.json());

// HTTP 서버 생성
const server = require('http').createServer(app);

// WebSocket 서버 생성
const wss = new WebSocket.Server({ port: 8002 });

// 가상 데이터 저장 객체
let sensorData = {
    temperature: 0,
    humidity: 0,
    pressure: 0,
    poop: 'n',
    time: '',
};

let isAutoCleaning = false; // 자동 청소 중 여부
let detectedPoop = false;   // 배변 감지 여부
let isMonitoring = false;   // 강아지 올라와 있는지 감시 중 여부
let model;                  // AI 모델
let connectedClients = new Set(); // WebSocket 연결 클라이언트 목록

// AI 모델 로드
async function loadModel() {
    model = await tf.loadLayersModel('file://tfjs_model/model.json');
    console.log('✅ AI 모델 로드 완료');
}
loadModel();

// 웹캠 설정
const webcamOptions = {
    width: 640,
    height: 480,
    quality: 100,
    output: "jpeg",
    device: "/dev/video0",      // V4L2로 매핑된 Pi 카메라
    callbackReturn: "location",
    verbose: true               // 커맨드 로그를 터미널에 찍어 줍니다
};
const Webcam = NodeWebcam.create(webcamOptions);

// 사진 캡처 함수
const captureImage = () => {
    console.log('▶ NodeWebcam.capture 호출됨');
    Webcam.capture("test", (err, data) => {
        if (err) {
          console.error("❌ 웹캠 캡처 에러:", err);
    
          // 클라이언트에 에러 메시지 전송
          connectedClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'captureError',
                data: { message: err.message }
              }));
            }
          });
          return;
        }
    
        console.log("✅ 사진 캡처 완료:", data);
    
        // 클라이언트에 성공 메시지 전송
        connectedClients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'captureSuccess',
              data: { filename: data }  // 예: "test.jpg"
            }));
          }
        });
      });
};

// 가상 센서 데이터 생성 함수
const generateRandomValue = (min = 20, max = 25, outlierChance = 0.25, outlierMin = 50, outlierMax = 70) => {
    const random = Math.random();
    if (random < outlierChance) {
        return parseFloat((outlierMin + Math.random() * (outlierMax - outlierMin)).toFixed(2));
    }
    return parseFloat((min + Math.random() * (max - min)).toFixed(2));
};

// 센서 데이터 갱신
const generateSensorData = () => {
    sensorData = {
        temperature: generateRandomValue(),
        humidity: generateRandomValue(),
        pressure: generateRandomValue(20, 80), // 압력 20~80 범위
        color: detectedPoop ? 'y' : 'n',
        time: new Date().toISOString(),
    };
    console.log('Generated Sensor Data:', sensorData);

    broadcastSensorData(sensorData);

    // 강아지가 올라오면 감시 시작
    if (sensorData.pressure >= 25 && !isAutoCleaning) {
        startMonitoring();
    }


    //카메라테스트용 테스트후 지워야함
    if (sensorData.pressure >= 30) {
        console.log('▶ 테스트용 직접 captureImage() 호출');
        captureImage();
    }
};

// WebSocket으로 데이터 전송
const broadcastSensorData = data => {
    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'sensorUpdate', data }));
        }
    });
};

// 강아지 올라온 이후 압력 감시 시작
const startMonitoring = () => {
    if (isMonitoring) return;
    isMonitoring = true;
    console.log('🧍 강아지가 올라왔습니다. 감시 시작.');

    const monitorInterval = setInterval(() => {
        if (sensorData.pressure < 35) {
            console.log('⬇️ 강아지가 내려갔습니다. 사진 촬영 및 AI 분석 시작.');

            clearInterval(monitorInterval);
            isMonitoring = false;

            captureImage();
            setTimeout(async () => {
                await detectColor();
                if (detectedPoop) {
                    console.log('💩 배변 감지됨! 자동 청소 시작.');
                    startAutoClean();
                } else {
                    console.log('🧹 배변 없음. 청소 안함.');
                }
            }, 2500);
        }
    }, 3000);
};

// AI로 똥/오줌 감지
const detectColor = async () => {
    if (!model) {
        console.log('⛔ 모델이 아직 로드되지 않았습니다.');
        return;
    }

    try {
        const imageBuffer = fs.readFileSync('test.jpg');
        const tensor = tf.node.decodeImage(imageBuffer)
            .resizeNearestNeighbor([64, 64])
            .toFloat()
            .expandDims();

        const prediction = await model.predict(tensor).data();
        const poopIndex = prediction.indexOf(Math.max(...prediction));

        if (poopIndex === 0) {
            detectedPoop = true;
            console.log('💩 똥이 감지되었습니다.');
        } else if (poopIndex === 1) {
            detectedPoop = true;
            console.log('💧 오줌이 감지되었습니다.');
        } else {
            detectedPoop = false;
            console.log('❌ 배변 감지 안됨');
        }
    } catch (error) {
        console.error('❗ 예측 중 에러:', error);
    }
};

// 자동 청소 시작
const startAutoClean = () => {
    isAutoCleaning = true;
    console.log('🧹 자동 청소 시작!');

    servo.servoWrite(500);   // 0도
    setTimeout(() => servo.servoWrite(2500), 2000); // 180도
    setTimeout(() => servo.servoWrite(1500), 4000); // 90도 복귀

    setTimeout(() => {
        console.log('✅ 자동 청소 완료.');
        detectedPoop = false;
        isAutoCleaning = false;
    }, 10000);
};

// 수동 청소
const handleManualClean = ws => {
    console.log('🖐️ 수동 청소 요청 처리.');

    sensorData = {
        temperature: generateRandomValue(),
        humidity: generateRandomValue(),
        pressure: generateRandomValue(),
        color: detectedPoop ? 'y' : 'n',
        poop: 'y',
        type: 'hand',
        time: new Date().toISOString(),
    };
    broadcastSensorData(sensorData);

    isAutoCleaning = true;

    servo.servoWrite(500);
    setTimeout(() => servo.servoWrite(2500), 2000);
    setTimeout(() => servo.servoWrite(1500), 4000);

    ws.send(JSON.stringify({
        type: 'manualClean',
        data: { status: 'started' }
    }));

    setTimeout(() => {
        console.log('✅ 수동 청소 완료.');
        sensorData = {
            temperature: generateRandomValue(),
            humidity: generateRandomValue(),
            pressure: generateRandomValue(),
            color: detectedPoop ? 'y' : 'n',
            poop: 'y',
            type: 'handDone',
            time: new Date().toISOString(),
        };
        broadcastSensorData(sensorData);
        detectedPoop = false;
        isAutoCleaning = false;
    }, 10000);
};

// WebSocket 처리
wss.on('connection', ws => {
    connectedClients.add(ws);
    console.log('WebSocket 연결됨');

    const sensorInterval = setInterval(() => {
        if (!isAutoCleaning) {
            generateSensorData();
        }
    }, 5000);

    ws.on('message', message => {
        const receivedData = JSON.parse(message);
        console.log('WebSocket 수신:', receivedData);

        if (receivedData.type === 'manualClean' && receivedData.data.poop === 'y') {
            handleManualClean(ws);
        }
    });

    ws.on('close', () => {
        connectedClients.delete(ws);
        clearInterval(sensorInterval);
        console.log('WebSocket 연결 종료');
    });
});

// API 엔드포인트
app.get('/api/sensor', (req, res) => {
    res.status(200).json(sensorData);
});

// 서버 시작
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`WebSocket running at ws://localhost:8002`);
});
