# Railway Pi Monitoring Agent

Raspberry Pi edge agent for the [Railway Lobby Monitoring System](https://railwaymonitor.in). Works with the `railway-monitor` backend.

## Repository Layout

```
pi-code/
├── agent/                 # Production monitoring agent (use this)
│   ├── src/
│   │   ├── index.js       # Entry point
│   │   ├── config.js
│   │   ├── auth.js        # JWT device-token
│   │   ├── socket.js      # Socket.IO connection
│   │   ├── heartbeat.js
│   │   ├── streams.js     # MediaMTX path polling
│   │   ├── screenshot.js
│   │   ├── commands.js
│   │   └── updater.js
│   ├── package.json
│   ├── ecosystem.config.js
│   └── .env.example
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   └── DEPLOYMENT.md
└── index.js               # Legacy agent (deprecated)
```

## Quick Start

```bash
cd agent
cp .env.example .env
npm install
npm start
```

See [agent/README.md](agent/README.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Backend

The Express + Socket.IO backend lives in the sibling `railway-monitor` repository with the new `src/modules/monitoring` module mounted at `/api/monitoring`.

## Documentation

- [Architecture & sequence diagrams](docs/ARCHITECTURE.md)
- [API reference](docs/API.md)
- [Deployment guide](docs/DEPLOYMENT.md)
