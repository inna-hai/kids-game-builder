# 🎮 בונה משחקים - Kids Game Builder

AI-powered game builder for kids ages 9-11. Kids describe a game in Hebrew, and AI creates a playable web game!

## Features

- 🇮🇱 Hebrew interface designed for kids
- 🤖 AI-powered game generation (Claude)
- 🎨 Colorful, kid-friendly design
- 💾 Save and share games
- 📱 Works on desktop and mobile
- 🔊 Support for sounds and images

## Quick Start

```bash
# Install dependencies
npm install

# Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-your-key-here

# Run the server
npm start
```

Open http://localhost:3002

## How It Works

1. Kid describes a game in Hebrew
2. AI (GPT-4) generates complete HTML/CSS/JS code
3. Game runs in an iframe
4. Can save, share, and play fullscreen

## Tech Stack

- Node.js + Express
- Anthropic Claude Sonnet
- SQLite for game storage
- Vanilla JS frontend

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `PORT` | Server port (default: 3002) |

## License

Private - Hai Tech © 2026
