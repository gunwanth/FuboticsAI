# Fubotics Chat Backend

A Node.js/Express backend for the Fubotics AI Chat application. This server handles chat session management, message persistence, and OpenAI API integration.

## Features

- **Session Management**: Create, retrieve, and delete chat sessions
- **Message History**: Store and retrieve chat messages from SQLite database
- **AI Integration**: OpenAI API integration for intelligent responses
- **CORS Enabled**: Cross-origin requests support for frontend communication

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- OpenAI API key

## Installation

1. Clone the repository:
```bash
cd fubotics-chat-backend
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```
OPENAI_API_KEY=your_api_key_here
PORT=5000
```

## Scripts

- `npm start` - Start the production server
- `npm run dev` - Start development server with hot reload (nodemon)

## API Endpoints

### Sessions
- `GET /api/sessions` - Retrieve all chat sessions
- `POST /api/sessions` - Create a new chat session
- `DELETE /api/sessions/:id` - Delete a chat session

### Messages
- `GET /api/messages?sessionId=<id>` - Retrieve messages for a session
- `POST /api/messages` - Send a message and get AI response

## Environment Variables

- `OPENAI_API_KEY` - Your OpenAI API key
- `PORT` - Server port (default: 5000)

## Database

Uses SQLite3 for persistent storage of sessions and messages.

## Technology Stack

- Express.js - Web framework
- SQLite3 - Database
- OpenAI - AI API
- CORS - Cross-origin resource sharing
- Dotenv - Environment configuration
