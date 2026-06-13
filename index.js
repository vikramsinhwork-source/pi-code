require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");
const { exec } = require("child_process");

const DEVICE_ID = process.env.DEVICE_ID;
const API_URL = process.env.API_URL;
const WS_URL = process.env.WS_URL;
const STREAM_NAME = process.env.STREAM_NAME;

let ffmpegProcess = null;

async function registerDevice() {
  try {
    await axios.post(
      `${API_URL}/api/monitoring/devices/register`,
      {
        deviceId: DEVICE_ID,
        stationCode: process.env.STATION_CODE,
        hostname: require("os").hostname()
      }
    );

    console.log("Device registered");
  } catch (err) {
    console.log("Register failed:", err.message);
  }
}

async function heartbeat() {
  try {
    await axios.post(
      `${API_URL}/api/monitoring/devices/heartbeat`,
      {
        deviceId: DEVICE_ID
      }
    );
  } catch (err) {
    console.log("Heartbeat failed");
  }
}

function startStreaming() {
  if (ffmpegProcess) {
    console.log("Already streaming");
    return;
  }

  console.log("Starting stream");

  ffmpegProcess = exec(`
ffmpeg \
-f mjpeg \
-i http://127.0.0.1:1984/api/frame.jpeg?src=${STREAM_NAME} \
-r 10 \
-f null -
`);

  ffmpegProcess.on("close", () => {
    ffmpegProcess = null;
  });
}

function stopStreaming() {
  if (!ffmpegProcess) return;

  ffmpegProcess.kill("SIGKILL");
  ffmpegProcess = null;

  console.log("Stream stopped");
}

function connectWS() {
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("WS connected");

    ws.send(
      JSON.stringify({
        type: "REGISTER",
        deviceId: DEVICE_ID
      })
    );
  });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      console.log("Message:", data);

      if (data.type === "START_STREAM") {
        startStreaming();
      }

      if (data.type === "STOP_STREAM") {
        stopStreaming();
      }
    } catch (err) {}
  });

  ws.on("close", () => {
    console.log("WS disconnected");

    setTimeout(connectWS, 5000);
  });

  ws.on("error", () => {
    ws.close();
  });
}

(async () => {
  await registerDevice();

  connectWS();

  setInterval(heartbeat, 30000);
})();
