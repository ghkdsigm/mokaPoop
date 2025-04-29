const express = require('express')
const bodyParser = require('body-parser')
const WebSocket = require('ws')
const cors = require('cors')

//AI
const tf = require('@tensorflow/tfjs-node');
const fs = require('fs');

const app = express()
const PORT = 8001

// AI
let model;

async function loadModel() {
  model = await tf.loadLayersModel('file://tfjs_model/model.json');
  console.log('✅ AI 모델 로드 완료');
}

loadModel();

// 웹캠
const NodeWebcam = require('node-webcam');

// 웹캠 옵션 설정
const webcamOptions = {
    width: 640,
    height: 480,
    quality: 100,
    output: "jpeg",
    device: false,  // 기본 디바이스 사용
    callbackReturn: "location",
    verbose: false
};

// 웹캠 객체 생성
const Webcam = NodeWebcam.create(webcamOptions);

// 사진 찍는 함수
const captureImage = () => {
    Webcam.capture("test", function(err, data) {
        if (err) {
            console.error("웹캠 캡처 에러:", err);
        } else {
            console.log("✅ 사진 캡처 완료:", data); // data가 저장된 파일 경로
        }
    });
};


// 서보모터
const Gpio = require('pigpio').Gpio
const servo = new Gpio(18, { mode: Gpio.OUTPUT }) // GPIO 18번

// Body-parser 설정
app.use(cors())
app.use(bodyParser.json())

// HTTP 서버 생성
const server = require('http').createServer(app)

// WebSocket 서버 생성
const wss = new WebSocket.Server({ port: 8002 })

// 가상 데이터 저장 객체
let sensorData = {
    temperature: 0,
    humidity: 0,
    pressure: 0,
    poop: 'n',
    time: '',
}

let isAutoCleaning = false // 자동 청소 상태 플래그
let detectedPoop = false // 똥 색상 감지 여부

// WebSocket 클라이언트 목록
let connectedClients = new Set()

// 가상 데이터 생성 함수
const generateRandomValue = (min = 20, max = 25, outlierChance = 0.25, outlierMin = 50, outlierMax = 70) => {
    const random = Math.random()
    if (random < outlierChance) {
        return parseFloat((outlierMin + Math.random() * (outlierMax - outlierMin)).toFixed(2))
    }
    return parseFloat((min + Math.random() * (max - min)).toFixed(2))
}

// 가상 데이터 생성 및 WebSocket 브로드캐스트
const generateSensorData = () => {
    sensorData = {
        temperature: generateRandomValue(),
        humidity: generateRandomValue(),
        pressure: generateRandomValue(),
        color: detectedPoop ? 'y' : 'n',
        time: new Date().toISOString(),
    }
    console.log('Generated Sensor Data:', sensorData)

    // WebSocket으로 데이터 전송
    broadcastSensorData(sensorData)

    // 압력 센서 값이나 색상 구분에 따라 감시 시작
    if (((sensorData.pressure >= 50 && sensorData.pressure <= 80) || detectedPoop) && !isAutoCleaning) {
        detectedPoop ? startMonitoring('poop') : sensorData.pressure >= 50 ? startMonitoring('press') : null
    }
}

// WebSocket으로 데이터 전송
const broadcastSensorData = data => {
    if (data.type !== 'hand' || data.type !== 'handDone') {
        connectedClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'sensorUpdate', data }))
            }
        })
    } else {
        connectedClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'handUpdate', data }))
            }
        })
    }
}

// 감시 시작 함수 (압력 센서나 색상 구분 조건이 충족되었을 때)
const startMonitoring = info => {
    if (isAutoCleaning) return

    if (info === 'poop') console.log('대소변이 색상이 감지되었습니다. 자동 청소 여부를 체크합니다.')
    if (info === 'press') console.log('강아지가 올라와있습니다. 자동 청소 여부를 체크합니다.')

    // 1분 동안 온도와 습도를 체크
    let monitoringInterval = setInterval(() => {
        isAutoCleaning = true
        if (sensorData.temperature >= 50 && sensorData.humidity >= 50 && detectedPoop) {
            console.log('색상 판독 결과 및 온도와 습도가 기준치를 초과했습니다. 자동 청소를 시작합니다.')
            sensorData = {
                temperature: generateRandomValue(),
                humidity: generateRandomValue(),
                pressure: generateRandomValue(),
                color: detectedPoop ? 'y' : 'n',
                poop: 'y',
                time: new Date().toISOString(),
            }
            broadcastSensorData(sensorData)
            clearInterval(monitoringInterval)
            startAutoClean()
        }
    }, 5000) // 5초 간격으로 체크(이걸 대략 1분으로 맞춰야함)

    // 1분 후 모니터링 종료
    setTimeout(() => {
        isAutoCleaning = false
        clearInterval(monitoringInterval)
        console.log('1분 동안 온도와 습도를 체크했으나 기준치를 초과하지 않았습니다. 다시 감시를 시작합니다.')
    }, 10000) //이걸 대략 2분으로 맞춰야함
}

// 자동 청소 시작 함수
const startAutoClean = () => {
    isAutoCleaning = true
    console.log('자동 청소를 시작합니다.')

    // 서보 모터 동작 예시
    servo.servoWrite(500)  // 0도
    setTimeout(() => {
        servo.servoWrite(2500) // 180도
    }, 2000)
    setTimeout(() => {
        servo.servoWrite(1500) // 중간 (90도)로 복귀
    }, 4000)

    setTimeout(() => {
        console.log('자동 청소가 완료되었습니다. 다시 감시를 시작합니다.')
        detectedPoop = false
        isAutoCleaning = false
    }, 10000) // 10초 동안 자동 청소 진행
}

// 수동 청소 함수
const handleManualClean = ws => {
    console.log('수동 청소 요청을 처리합니다.')
    sensorData = {
        temperature: generateRandomValue(),
        humidity: generateRandomValue(),
        pressure: generateRandomValue(),
        color: detectedPoop ? 'y' : 'n',
        poop: 'y',
        type: 'hand',
        time: new Date().toISOString(),
    }
    broadcastSensorData(sensorData)
    isAutoCleaning = true

    // 서보 모터 동작 (수동 청소)
    servo.servoWrite(500)  // 0도
    setTimeout(() => {
        servo.servoWrite(2500) // 180도
    }, 2000)
    setTimeout(() => {
        servo.servoWrite(1500) // 90도 (중간 복귀)
    }, 4000)

    // 즉시 수동 청소 실행
    ws.send(JSON.stringify({
        type: 'manualClean',
        data: { status: 'started' } // 예시로 수동 청소 시작 알림
    }))
    setTimeout(() => {
        console.log('수동 청소가 완료되었습니다. 다시 감시를 시작합니다.')
        sensorData = {
            temperature: generateRandomValue(),
            humidity: generateRandomValue(),
            pressure: generateRandomValue(),
            color: detectedPoop ? 'y' : 'n',
            poop: 'y',
            type: 'handDone',
            time: new Date().toISOString(),
        }
        broadcastSensorData(sensorData)
        detectedPoop = false
        isAutoCleaning = false
    }, 10000) // 10초 동안 수동 청소 진행
}

// 색상 센서 값 감지 함수 (가상 구현)
const detectColor = async () => {
    if (!model) {
      console.log('⛔ 모델이 아직 로드되지 않았습니다.');
      return;
    }
  
    try {
      // 여기선 임시로 'test.jpg' 파일을 읽는다고 가정
      const imageBuffer = fs.readFileSync('test.jpg'); // << 나중에 웹캠 캡처해서 저장된 경로로 바꿈
      const tensor = tf.node.decodeImage(imageBuffer)
        .resizeNearestNeighbor([64, 64])
        .toFloat()
        .expandDims();
  
      const prediction = await model.predict(tensor).data(); // [0.1, 0.8, 0.1] 이런식으로 나옴
      const poopIndex = prediction.indexOf(Math.max(...prediction)); // 제일 높은 확률
  
      if (poopIndex === 0) {
        detectedPoop = true; // 똥
        console.log('💩 똥이 감지되었습니다.');
      } else if (poopIndex === 1) {
        detectedPoop = true; // 오줌 (똑같이 true로 하자)
        console.log('💧 오줌이 감지되었습니다.');
      } else {
        detectedPoop = false; // none
        console.log('❌ 배변 감지 안됨');
      }
    } catch (error) {
      console.error('❗ 예측 중 에러:', error);
    }
  };

// WebSocket 연결 처리
wss.on('connection', ws => {
    connectedClients.add(ws) // 클라이언트 등록

    setInterval(() => {
        //console.log('isAutoCleaningisAutoCleaningisAutoCleaning', isAutoCleaning)
        if (!isAutoCleaning) {
            //가상 데이터 생성
            generateSensorData()
            captureImage(); // 사진 먼저 찍고	
            //색상 감지 기능 주기적으로 실행
            setTimeout(async () => {
                await detectColor(); // 사진 저장 후 AI 예측
    
                if (detectedPoop) {
                    console.log('🚽 배변 감지됨! 자동 청소를 시작합니다.');
                    startAutoClean();
                } // 약간 기다렸다가 예측 (찍는 시간 필요함)
            }, 2500); // 2.5초 정도 텀 줘야 test.jpg 저장되고나서
        }
    }, 5000)
    console.log('WebSocket 연결이 설정되었습니다.')

    // WebSocket 메시지 처리
    ws.on('message', message => {
        console.log('RAW MESSAGE:', message.toString()) // 🔥추가
        const receivedData = JSON.parse(message)
        console.log('Received WebSocket message:', receivedData)

        if (receivedData.type === 'manualClean' && receivedData.data.poop === 'y') {
            handleManualClean(ws)
        }
    })

    // WebSocket 연결 종료 처리
    ws.on('close', () => {
        connectedClients.delete(ws) // 클라이언트 제거
        console.log('WebSocket 연결이 종료되었습니다.')
    })
})

// API 엔드포인트: 현재 데이터 조회
app.get('/api/sensor', (req, res) => {
    res.status(200).json(sensorData)
})

// 서버 실행
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`)
    console.log(`WebSocket server is running on ws://localhost:8002`)
})
