# Fubotics Chat Frontend

A modern React-based chat interface for the Fubotics AI Chat application. Built with Vite for fast development and optimized builds.

## Features

- **Multi-Session Support**: Create and manage multiple chat sessions
- **Real-time Messaging**: Send messages and receive AI responses
- **Message History**: View complete conversation history
- **Code Block Support**: Syntax-highlighted code blocks with copy functionality
- **Session Management**: Rename, delete, and switch between chat sessions
- **Responsive Design**: Works on desktop and tablet devices

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn

## Installation

1. Clone the repository:
```bash
cd fubotics-chat-frontend
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```
VITE_API_BASE_URL=http://localhost:5000
```

## Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build locally

## Configuration

The frontend connects to the backend API via the `VITE_API_BASE_URL` environment variable. Default is `http://localhost:5000`.

## Project Structure

- `src/App.jsx` - Main application component with chat logic
- `src/App.css` - Application styling
- `src/main.jsx` - Application entry point
- `index.html` - HTML template

## Key Components

### App.jsx
Manages:
- Chat sessions (create, delete, select)
- Message fetching and sending
- UI state (loading, input, selected session)
- Message rendering with code block support

## Technology Stack

- React 18 - UI framework
- Vite - Build tool
- Axios - HTTP client
- CSS3 - Styling

## Features in Detail

### Session Management
- Create new chat sessions with custom names
- Switch between sessions instantly
- Delete sessions with confirmation
- Sidebar displays all active sessions

### Message Rendering
- User messages aligned right
- AI responses aligned left
- Automatic code block detection and formatting
- Copy button for code blocks

### Input Handling
- Enter to send message
- Shift+Enter for new line
- Loading state prevents duplicate sends
- Optimistic UI updates for better UX
