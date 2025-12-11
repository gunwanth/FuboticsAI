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
# Create .env with OPENAI_API_KEY
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

- ✨ AI-powered chat with OpenAI
- 💾 Persistent chat sessions and history
- 🎨 Clean, modern UI with React
- 💻 Code block syntax highlighting
- 🔄 Multi-session management
- ⚡ Fast development with Vite

## Architecture

### Backend
- Express.js server with SQLite database
- RESTful API for session and message management
- OpenAI API integration for AI responses

### Frontend
- React SPA built with Vite
- Responsive sidebar for session management
- Real-time message updates
- Code block formatting and copying

## Documentation

For detailed information, see:
- [Backend README](./fubotics-chat-backend/README.md)
- [Frontend README](./fubotics-chat-frontend/README.md)

## Tech Stack

**Backend:**
- Node.js, Express.js, SQLite3, OpenAI API

**Frontend:**
- React, Vite, Axios

## License

ISC
