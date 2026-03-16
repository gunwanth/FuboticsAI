# Fubotics AI Chat

A full-stack chat application powered by OpenAI's API. This project consists of a Node.js/Express backend and a React frontend.

## Project Structure

```
fubotics-chat/
├── fubotics-chat-backend/    # Express API server
│   ├── index.js
│   ├── package.json
│   └── ...
└── fubotics-chat-frontend/   # React application
    ├── src/
    ├── package.json
    └── ...
```

## Quick Start

### Backend Setup

```bash
cd fubotics-chat-backend
npm install
# Create .env with SAMBANOVA_API_KEY
npm run dev
```

### Frontend Setup

```bash
cd fubotics-chat-frontend
npm install
# Create .env with VITE_API_BASE_URL=http://localhost:5000
npm run dev
```

Visit `http://localhost:5173` (or your frontend dev URL) to access the application.

## System Requirements

- Node.js v14+
- npm or yarn
- OpenAI API key

## Features

- ✨ AI-powered chat with Dino 1.0 (Web-Connected Agent)
- 💾 Persistent chat sessions and history
- 🦕 Autonomous self-learning and web data extraction
- 🎨 Clean, modern UI with React
- 💻 Code block syntax highlighting
- 🔄 Multi-session management
- ⚡ Powered by high-speed Web LLM APIs

## Architecture

### Backend
- Express.js server with PostgreSQL database
- Web-Connected Agentic loop for autonomous search and learning
- SambaNova API integration for high-performance reasoning

### Frontend
- React SPA built with Vite
- Responsive sidebar for session management
- Real-time message updates
- Code block formatting and copying

## Documentation

For detailed information, see:
- [Backend README](./fubotics-chat-backend/README.md)
- [Frontend README](./fubotics-chat-frontend/README.md)
- [Troubleshooting Guide](./TROUBLESHOOTING.md)

## Tech Stack

**Backend:**
- Node.js, Express.js, PostgreSQL, SambaNova API

**Frontend:**
- React, Vite, Axios

## License

ISC
