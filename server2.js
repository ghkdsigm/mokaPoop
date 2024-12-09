const express = require('express')
const WebSocket = require('ws')
const cors = require('cors')

const app = express()
const PORT = 8001

// CORS 설정
app.use(cors())

// HTTP 서버 생성
const server = require('http').createServer(app)

// WebSocket 서버 생성
const wss = new WebSocket.Server({ port: 8002 })

// 센서 상태
let sensorData = {
	pressure: 0,
	colorDetected: false,
	temperature: 0,
	humidity: 0,
}

let isMonitoring = false // 전체 모니터링 상태
let isAutoCleaning = false // 자동 청소 중인지 여부

// 클라이언트 연결 관리
let connectedClients = new Set()

// 가상 센서 데이터 생성
const generateRandomValue = (min, max) => parseFloat((min + Math.random() * (max - min)).toFixed(2))

const generateSensorData = () => {
	sensorData.pressure = generateRandomValue(20, 60) // 압력 센서 데이터
	sensorData.colorDetected = Math.random() < 0.2 // 색상 감지
}

// 클라이언트로 메시지 전송 함수
const sendMessageToClients = (type, data) => {
	const message = JSON.stringify({ type, data })
	connectedClients.forEach(client => {
		if (client.readyState === WebSocket.OPEN) {
			client.send(message)
		}
	})
}

// 센서 모니터링 함수
const startMonitoring = () => {
	isMonitoring = true
	const monitorInterval = setInterval(() => {
		if (!isMonitoring) {
			clearInterval(monitorInterval)
			return
		}

		generateSensorData()
		console.log('Sensor Data:', sensorData)

		sendMessageToClients('sensorUpdate', {
			pressure: sensorData.pressure,
			colorDetected: sensorData.colorDetected,
			temperature: sensorData.temperature,
			humidity: sensorData.humidity,
			poop: sensorData.pressure >= 50 || sensorData.colorDetected ? 'y' : 'n',
			time: new Date().toISOString(),
		})

		if (!isAutoCleaning && (sensorData.pressure >= 50 || sensorData.colorDetected)) {
			console.log('조건 충족: 온습도 체크 시작')
			checkTemperatureAndHumidity()
			clearInterval(monitorInterval) // 센서 체크 일시 중단
		}
	}, 5000) // 5초 간격으로 센서 데이터 생성
}

// 온습도 체크 함수
const checkTemperatureAndHumidity = () => {
	let tempAndHumidityInterval = setInterval(() => {
		sensorData.temperature = generateRandomValue(30, 60) // 온도 데이터
		sensorData.humidity = generateRandomValue(30, 60) // 습도 데이터

		console.log('온습도 데이터:', sensorData)

		if (sensorData.temperature >= 50 && sensorData.humidity >= 50) {
			clearInterval(tempAndHumidityInterval)
			console.log('온습도 기준 충족: 자동 청소 시작')
			startAutoClean()
		}
	}, 2000)

	// 10초 후 온습도 체크 종료
	setTimeout(() => {
		clearInterval(tempAndHumidityInterval)
		if (!isAutoCleaning) {
			console.log('온습도 기준 미달: 센서 모니터링 재개')
			startMonitoring()
		}
	}, 10000)
}

// 자동 청소 함수
const startAutoClean = () => {
	isAutoCleaning = true
	sendMessageToClients('cleaningStart', { time: new Date().toISOString() })
	console.log('자동 청소 진행 중...')

	setTimeout(() => {
		isAutoCleaning = false
		sendMessageToClients('cleaningComplete', { time: new Date().toISOString() })
		console.log('자동 청소 완료')
		startMonitoring()
	}, 10000) // 10초 동안 청소 진행
}

// WebSocket 메시지 처리
wss.on('connection', ws => {
	connectedClients.add(ws)

	ws.on('message', message => {
		console.log('클라이언트 메시지 수신:', message)
		const { type } = JSON.parse(message)
		if (type === 'start') {
			if (!isMonitoring) {
				console.log('모니터링 시작')
				startMonitoring()
			}
		} else if (type === 'stop') {
			console.log('모니터링 중단')
			isMonitoring = false
		} else if (type === 'manualClean') {
			console.log('수동 청소 요청')
			checkTemperatureAndHumidity()
		}
	})

	ws.on('close', () => {
		connectedClients.delete(ws)
		console.log('클라이언트 연결 종료됨')
	})
})

// 서버 실행
server.listen(PORT, () => {
	console.log(`Server is running on http://localhost:${PORT}`)
	console.log(`WebSocket server is running on ws://localhost:8002`)
})
