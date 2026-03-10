# 🐄 Wafrivet Field Vet: Real-Time Multimodal AI Vet

![Google Cloud](https://img.shields.io/badge/GoogleCloud-%234285F4.svg?style=for-the-badge&logo=google-cloud&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini%20Live-%238E75B2.svg?style=for-the-badge&logo=googlebard&logoColor=white)
![Next JS](https://img.shields.io/badge/Next-black?style=for-the-badge&logo=next.js&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)

> **Submission for Gemini Live Agent Challenge 🏆**
> **Tracks:** Best of Live Agents & Best Innovation

Millions of livestock farmers in West Africa lack immediate access to veterinary care. **Wafrivet Field Vet** is a real-time, vision-enabled AI assistant that fits in a farmer's pocket. 

Using a standard smartphone browser, a farmer points their camera at a sick animal and simply talks. The AI simultaneously analyzes the live video feed (posture, lesions) and the farmer's audio (in Hausa, Yoruba, Pidgin, or English). It responds with a real-time synthesized voice, instantly pushing relevant treatment products to the screen, and handling interruptions naturally. 

🎥 **[Watch the < 4 Min Demo Video Here](LINK_TO_YOUTUBE_OR_DRIVE)**

## 🏗️ System Architecture (The Multimodal WebSocket Loop)


## ✨ Features

* **Real-Time Vision & Audio:** Streams mic audio and camera frames directly to Gemini Live API. The AI *sees* what you see and *hears* what you say simultaneously.
* **Interruptible AI:** A true conversation. If the farmer cuts the AI off ("Wait, show me the second product"), the audio stream halts instantly, and the AI adapts.
* **Synchronized UI:** When the Google ADK triggers `recommend_products()`, the backend simultaneously feeds the product data to Gemini's context window AND pushes the JSON to the Next.js frontend to render the images on screen instantly.
* **No-Install App:** Built with Next.js and the standard `MediaStream API`, ensuring farmers don't need to download a heavy app—just tap a link and start talking.

## 💻 Tech Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Frontend** | Next.js / React | Mobile-first UI, WebSockets, MediaStream API |
| **Backend** | Python FastAPI (or NestJS) | WebSocket router and ADK orchestrator |
| **Core AI** | Gemini 2.0 Flash (Live API) | Native STT/TTS and visual reasoning |
| **Agent Framework**| Google ADK | Tool execution for RAG and e-commerce |
| **Database** | Supabase (PostgreSQL + pgvector) | Stores localized product catalogs and disease vectors |
| **Hosting** | Google Cloud Run | Fully containerized deployment |

## 🚀 Local Development Setup

### Prerequisites
* Node.js (v18+) & Python 3.10+
* Google Cloud Project (Gemini API & Vertex AI enabled)
* Supabase Account

### 1. Backend Setup
```bash
cd backend
pip install -r requirements.txt
cp .env.example .env # Add your Gemini & Supabase keys
uvicorn main:app --reload --port 8000