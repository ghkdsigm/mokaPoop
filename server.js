const express = require('express')
const bodyParser = require('body-parser')
const WebSocket = require('ws')
const cors = require('cors')

const app = express()
const PORT = 8001

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

	// 즉시 수동 청소 실행
	ws.send(JSON.stringify({ type: 'manualClean' }))
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
const detectColor = () => {
	// 색상 감지 로직
	const colorDetected = Math.random() < 0.2 // 20% 확률로 색상 감지
	if (colorDetected) {
		detectedPoop = true
	} else {
		detectedPoop = false
	}
}

// WebSocket 연결 처리
wss.on('connection', ws => {
	connectedClients.add(ws) // 클라이언트 등록

	setInterval(() => {
		//console.log('isAutoCleaningisAutoCleaningisAutoCleaning', isAutoCleaning)
		if (!isAutoCleaning) {
			//가상 데이터 생성
			generateSensorData()
			//색상 감지 기능 주기적으로 실행
			detectColor()
		}
	}, 5000)
	console.log('WebSocket 연결이 설정되었습니다.')

	// WebSocket 메시지 처리
	ws.on('message', message => {
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
