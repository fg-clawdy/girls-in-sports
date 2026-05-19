# Girls In Sports (GIS)

AI-powered video composition and media ranking platform for youth sports camps and coaching clinics.

## Features

- **AI Media Ranking** — Vision AI scores uploaded photos/videos for marketing quality
- **Intent-Driven Composition** — Describe what you want, AI generates a production script
- **Smart Video Editing** — Automatic scene detection, beat-sync cuts, branded outros
- **A/B Testing** — Generate multiple variants and compare performance
- **Feedback Loop** — User ratings feed back into the ML pipeline for continuous improvement

## Tech Stack

- **Frontend:** Next.js 14, React 18, Tailwind CSS
- **Backend:** Next.js API routes, Prisma ORM, PostgreSQL
- **AI/ML:** Venice.ai (LLM inference), librosa (audio analysis), ffmpeg (video processing)
- **Media Storage:** Immich (self-hosted photo/video management)

## Getting Started

1. Copy `.env.example` to `.env` and fill in your values
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set up the database:
   ```bash
   npx prisma db push
   ```
4. Run the dev server:
   ```bash
   npm run dev
   ```

## Environment Variables

See `.env.example` for all required variables.

## License

MIT
