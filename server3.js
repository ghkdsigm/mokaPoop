const express = require('express')
const bodyParser = require('body-parser')
const WebSocket = require('ws')
const cors = require('cors')

const app = express()
const PORT = 8001

// 서보모터
const Gpio = require('pigpio').Gpio
const servo = new Gpio(18, { mode: Gpio.OUTPUT }) // GPIO 18번

app.use(cors())
app.use(bodyParser.json())

const server = require('http').createServer(app)
const wss = new WebSocket.Server({ port: 8002 })

let sensorData = {
	temperature: 0,
	humidity: 0,
	pressure: 0,
	color: 'n',
	poop: 'n',
	time: '',
}

let isAutoCleaning = false
let detectedPoop = false
let isDogOnPad = false // 강아지 올라와 있는지 여부
let monitoringInterval = null

const generateRandomValue = (min = 20, max = 25, outlierChance = 0.25, outlierMin = 50, outlierMax = 70) => {
	const random = Math.random()
	if (random < outlierChance) {
		return parseFloat((outlierMin + Math.random() * (outlierMax - outlierMin)).toFixed(2))
	}
	return parseFloat((min + Math.random() * (max - min)).toFixed(2))
}

const generateSensorData = () => {
	sensorData = {
		temperature: generateRandomValue(),
		humidity: generateRandomValue(),
		pressure: generateRandomValue(),
		color: detectedPoop ? 'y' : 'n',
		poop: detectedPoop ? 'y' : 'n',
		time: new Date().toISOString(),
	}
	console.log('Generated Sensor Data:', sensorData)

	broadcastSensorData(sensorData)

	// 강아지 올라온 것 감지
	if (sensorData.pressure >= 50) {
		if (!isDogOnPad) {
			console.log('강아지가 올라왔습니다.')
			isDogOnPad = true
			startMonitoring()
		}
	}

	// 강아지 내려간 것 감지
	if (sensorData.pressure < 50) {
		if (isDogOnPad) {
			console.log('강아지가 내려갔습니다.')
			isDogOnPad = false
			// 내려갔을 때 poop 감지되어 있으면 청소 시작
			if (detectedPoop && !isAutoCleaning) {
				startAutoClean()
			}
		}
	}
}

const broadcastSensorData = data => {
	connectedClients.forEach(client => {
		if (client.readyState === WebSocket.OPEN) {
			client.send(JSON.stringify({ type: 'sensorUpdate', data }))
		}
	})
}

const startMonitoring = () => {
	// 기존 모니터링 중이면 무시
	if (monitoringInterval) return

	console.log('강아지가 내려갈 때까지 감시를 시작합니다.')

	monitoringInterval = setInterval(() => {
		// 모니터링 중 별도 행동은 하지 않고, pressure 상태만 계속 체크한다
	}, 2000)

	// 만약 일정시간 (2분) 동안 강아지가 안내려가면 모니터링 종료
	setTimeout(() => {
		if (monitoringInterval) {
			clearInterval(monitoringInterval)
			monitoringInterval = null
			console.log('2분 동안 강아지가 내려가지 않아 모니터링을 종료합니다.')
		}
	}, 120000) // 2분
}

const startAutoClean = () => {
	isAutoCleaning = true
	console.log('자동 청소를 시작합니다.')

	// 서보 모터 동작
	servo.servoWrite(500) // 0도
	setTimeout(() => {
		servo.servoWrite(2500) // 180도
	}, 2000)
	setTimeout(() => {
		servo.servoWrite(1500) // 90도 (복귀)
	}, 4000)

	setTimeout(() => {
		console.log('자동 청소가 완료되었습니다. 다시 감시를 시작합니다.')
		detectedPoop = false
		isAutoCleaning = false
	}, 10000) // 10초 동안 청소
}

const handleManualClean = ws => {
	console.log('수동 청소 요청을 처리합니다.')

	sensorData = {
		temperature: generateRandomValue(),
		humidity: generateRandomValue(),
		pressure: generateRandomValue(),
		color: 'y',
		poop: 'y',
		time: new Date().toISOString(),
	}
	broadcastSensorData(sensorData)
	isAutoCleaning = true

	// 서보모터 수동 청소
	servo.servoWrite(500)
	setTimeout(() => {
		servo.servoWrite(2500)
	}, 2000)
	setTimeout(() => {
		servo.servoWrite(1500)
	}, 4000)

	ws.send(JSON.stringify({ type: 'manualClean', data: { status: 'started' } }))

	setTimeout(() => {
		console.log('수동 청소 완료')
		detectedPoop = false
		isAutoCleaning = false
	}, 10000)
}

const detectColor = () => {
	const colorDetected = Math.random() < 0.2 // 20% 확률
	detectedPoop = colorDetected
}

// WebSocket 처리
let connectedClients = new Set()

wss.on('connection', ws => {
	connectedClients.add(ws)
	console.log('WebSocket 연결이 설정되었습니다.')

	setInterval(() => {
		if (!isAutoCleaning) {
			generateSensorData()
			detectColor()
		}
	}, 5000)

	ws.on('message', message => {
		console.log('RAW MESSAGE:', message.toString())
		const receivedData = JSON.parse(message)
		console.log('Received WebSocket message:', receivedData)

		if (receivedData.type === 'manualClean' && receivedData.data.poop === 'y') {
			handleManualClean(ws)
		}
	})

	ws.on('close', () => {
		connectedClients.delete(ws)
		console.log('WebSocket 연결이 종료되었습니다.')
	})
})

app.get('/api/sensor', (req, res) => {
	res.status(200).json(sensorData)
})

server.listen(PORT, () => {
	console.log(`Server is running on http://localhost:${PORT}`)
	console.log(`WebSocket server is running on ws://localhost:8002`)
})
