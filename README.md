# 🐄 Wafrivet Field Vet: Real-Time Multimodal AI Vet

![Deploy to Cloud Run](https://github.com/Tsu-kimi/Wafrivet-Field-Vet/actions/workflows/deploy.yml/badge.svg)
![Google Cloud](https://img.shields.io/badge/GoogleCloud-%234285F4.svg?style=for-the-badge&logo=google-cloud&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini%20Live-%238E75B2.svg?style=for-the-badge&logo=googlebard&logoColor=white)
![Next JS](https://img.shields.io/badge/Next-black?style=for-the-badge&logo=next.js&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)

> **Submission for Gemini Live Agent Challenge 🏆**
> **Tracks:** Best of Live Agents & Best Innovation

Millions of livestock farmers in West Africa lack immediate access to veterinary care. **Wafrivet Field Vet** is a real-time, vision-enabled AI assistant that fits in a farmer's pocket. 

Using a standard smartphone browser, a farmer points their camera at a sick animal and simply talks. The AI simultaneously analyzes the live video feed (posture, lesions) and the farmer's audio (in Hausa, Yoruba, Pidgin, or English). It responds with a real-time synthesized voice, instantly pushing relevant treatment products to the screen, and handling interruptions naturally. 

🎥 **[Watch the Demo Video Here](https://github.com/Tsu-kimi/Wafrivet-Field-Vet)**

---

## ✨ Key Features

*   **Real-Time Multimodal Interaction**: Streams mic audio and camera frames directly to the Gemini Live API. The AI *sees* what you see and *hears* what you say in real-time.
*   **Natural Interruption Handling**: A true conversation. If the user interrupts, the AI halts its response immediately and adapts to the new input.
*   **Intelligent Tool Integration**: Powered by Google ADK, the agent can search disease databases, update user location, and manage a shopping cart using specialized tools.
*   **Synchronized UI Updates**: When the agent recommends products, it simultaneously informs the AI context and pushes JSON data to the frontend to update the UI on-the-fly.
*   **Seamless Checkout**: Integrated with Paystack for instant payment link generation during the conversation.

---

## 🏗️ Technical Architecture

### Frontend (`/frontend`)
Built with **Next.js 15 (App Router)** and **TypeScript**, the frontend handles:
- **Media Pipeline**: Captures camera frames (every 1.5s) and audio chunks for streaming.
- **WebSocket Gateway**: Maintains a persistent connection to the backend for event-driven updates.
- **Custom Components**: Includes `CameraView`, `ProductCardRow`, `CartBadge`, and `LocationBanner` for a rich, interactive mobile experience.

### Backend (`/backend`)
A **FastAPI** application acting as the orchestrator:
- **Streaming Bridge**: Manages the persistent WebSocket connection between the client and the Gemini Live API.
- **Google ADK Agent**: A sophisticated agent configured with a custom toolset:
    - `disease.py`: RAG-based search for veterinary conditions using Supabase (pgvector).
    - `products.py`: Recommends matched products from the catalog.
    - `location.py`: Geolocation identification for localized care.
    - `cart.py` & `checkout.py`: Full cart lifecycle management and Paystack billing.
- **Session Management**: Persistent state tracking for cart items and confirmed locations.

---

## 🛠️ Tech Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Frontend** | Next.js / React | Mobile-first UI, WebSockets, MediaStream API |
| **Backend** | Python FastAPI | WebSocket router and ADK orchestrator |
| **Core AI** | Gemini 2.0 Flash | Native Multimodal (STT/TTS/Vision) reasoning |
| **Agent Framework**| Google ADK | Structured tool execution and RAG |
| **Database** | Supabase | PostgreSQL + pgvector for product/disease data |
| **Infrastructure** | Docker / GCR | Fully containerized deployment on Google Cloud |

---

## 📂 Directory Structure

```text
.
├── backend/            # FastAPI, ADK Agent, and Tools
│   ├── agent/          # Agent logic and tool definitions
│   ├── streaming/      # WebSocket bridge and event handling
│   └── main.py         # Entry point for the server
├── frontend/           # Next.js Application
│   ├── app/            # App Router pages and components
│   └── hooks/          # Media and WebSocket hooks
├── infra/              # Terraform/Pulumi infrastructure code
└── deploy/             # Deployment scripts and config
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+) & Python 3.10+
- Google Cloud Project (Gemini API & Vertex AI enabled)
- Supabase Account (PostgreSQL + pgvector)

### Installation

1.  **Clone the Repo**:
    ```bash
    git clone https://github.com/Tsu-kimi/Wafrivet-Field-Vet.git
    cd Wafrivet-Field-Vet
    ```

2.  **Backend Setup**:
    ```bash
    cd backend
    pip install -r requirements.txt
    # Configure .env with your keys
    python main.py
    ```

3.  **Frontend Setup**:
    ```bash
    cd frontend
    npm install
    npm run dev
    ```

---

## 🏆 Credits
Created by the **Wafrivet Team** for the Gemini Live Agent Challenge.